const aiService = require('./aiService');
const { logger } = require('./logger');

/**
 * Admin Agent Service
 * Handles natural language requests to manage the system using a JSON-based ReAct loop.
 */
class AdminAgent {
    constructor(db) {
        this.db = db;
        this.tools = this.defineTools();
    }

    isAiAssignmentRequest(text) {
        const normalized = String(text || '').trim().toLowerCase();
        if (!normalized) return false;
        const hasAiWord = /\b(ai|yapay zeka|asistan|bot)\b/.test(normalized);
        const hasAssignWord = /\b(ata|atama|bağla|bagla|assign)\b/.test(normalized);
        // Allow suffixes like "sohbetine", "sohbete", etc.
        const mentionsChat = /\bsohbet/.test(normalized) || /\bchat\b/.test(normalized);
        return hasAiWord && hasAssignWord && mentionsChat;
    }

    hasRecentAssignmentNotice(history = []) {
        if (!Array.isArray(history) || history.length === 0) return false;
        const tail = history.slice(-4);
        return tail.some((entry) => String(entry?.text || '').includes('[AI_ASSIGN_NOTICE]'));
    }

    hasAssignmentDetails(text) {
        const normalized = String(text || '').toLowerCase();
        if (!normalized) return false;
        const hasStyle = /\b(resmi|samimi|kibar|nazik|esprili|ciddi|kısa|kisa|uzun|tonu|üslup|uslup|karakter|rol)\b/.test(normalized);
        const hasTrigger = /\b(sadece|her mesaj|her gelen|komut|tetik|trigger|etiket|mention|@)\b/.test(normalized);
        const hasLimits = /\b(asla|yasak|kural|sınır|sinir|18\+|küfür|kufur|politik|tıbbi|tibbi|finans|gizli)\b/.test(normalized);
        return hasStyle || hasTrigger || hasLimits;
    }

    extractChatQuery(text) {
        const raw = String(text || '').trim();
        if (!raw) return null;
        const m1 = raw.match(/^\s*(.+?)\s+(sohbetine|sohbete|sohbeti\s+için|sohbeti\s+icin)\b/i);
        if (m1 && m1[1]) return m1[1].trim().slice(0, 120);
        const m2 = raw.match(/\bsohbet\s*:\s*([^\n]+)$/i);
        if (m2 && m2[1]) return m2[1].trim().slice(0, 120);
        return null;
    }

    injectAssignmentClarificationNotice(history, userMessage) {
        const userText = String(userMessage || '').trim();
        if (!this.isAiAssignmentRequest(userText)) return false;
        if (this.hasRecentAssignmentNotice(history)) return false;
        if (this.hasAssignmentDetails(userText)) return false;

        const chatQuery = this.extractChatQuery(userText);
        const chatLabel = chatQuery ? `"${chatQuery}"` : 'hedef sohbet';

        history.push({
            role: 'user',
            text: [
                '[AI_ASSIGN_NOTICE]',
                `User asked to assign an AI/bot to ${chatLabel}.`,
                'Before using any tools (especially create_script), ask 3-5 short clarifying questions about: persona/tone, when to reply (trigger rules), boundaries/forbidden topics, language/length, and cooldown/spam protection.',
                'Do NOT create or update any script until the user answers.'
            ].join(' ')
        });

        return true;
    }

    shouldGateAiAssignmentTools(history, userMessage) {
        const userText = String(userMessage || '').trim();
        if (!userText) return false;

        // Gate if the user just requested an assignment but hasn't provided any details yet.
        if (this.isAiAssignmentRequest(userText) && !this.hasAssignmentDetails(userText)) {
            return true;
        }

        // Gate if we're in a very recent assignment context and the user still hasn't provided details.
        if (this.hasRecentAssignmentNotice(history) && !this.hasAssignmentDetails(userText)) {
            return true;
        }

        return false;
    }

    defineTools() {
        return {
            find_chat: {
                description: 'Search for a chat by name to get its ID. Required before creating scripts for a specific person/group.',
                parameters: {
                    query: 'Name of the chat to search for'
                },
                execute: async ({ query }) => {
                    const chats = this.db.chats.search.all(`%${query}%`, 10, 0);
                    if (!chats.length) return "No chats found matching that name.";
                    return JSON.stringify(chats.map(c => ({ id: c.chat_id, name: c.name })));
                }
            },
            create_script: {
                description: 'Create a new script/bot. Use this to assign a bot or create a new automation. Prefer robust, production-ready scripts (guard rails, cooldown, history formatting).',
                parameters: {
                    name: 'Name of the script (e.g., "Pirate Bot for Mom")',
                    description: 'Short description',
                    code: 'The JavaScript code for the script. MUST be valid JS. Use helpers like msg, reply(), sendMessage(), buildHistory(), formatHistory(), aiGenerate(), storage.',
                    filter: 'JSON string for trigger_filter (e.g., {"chatIds": ["..."]})'
                },
                execute: async ({ name, description, code, filter }) => {
                    try {
                        const filterStr = typeof filter === 'string' ? filter : JSON.stringify(filter);
                        const res = this.db.scripts.create.run(
                            name,
                            description || '',
                            code,
                            'message',
                            filterStr,
                            1 // Active by default
                        );
                        return `Script created successfully with ID: ${res.lastInsertRowid}`;
                    } catch (e) {
                        return `Error creating script: ${e.message}`;
                    }
                }
            },
            list_scripts: {
                description: 'List currently active scripts.',
                parameters: {},
                execute: async () => {
                    const scripts = this.db.scripts.getActive.all();
                    return JSON.stringify(scripts.map(s => ({ id: s.id, name: s.name, trigger: s.trigger_filter })));
                }
            },
            delete_script: {
                description: 'Delete/Stop a script by ID.',
                parameters: { id: 'The ID of the script to delete' },
                execute: async ({ id }) => {
                    this.db.scripts.delete.run(id);
                    return `Script ${id} deleted.`;
                }
            }
        };
    }

    /**
     * Cleans up history to remove duplicates and keep it within token limits.
     * Also filters out garbage messages (like "}") to prevent pollution.
     */
    normalizeHistory(history = []) {
        if (!Array.isArray(history)) return [];
        
        // Basic deduplication and cleanup
        const clean = [];
        let lastRole = null;
        let lastText = null;

        for (const msg of history) {
            const role = msg.role === 'me' ? 'assistant' : (msg.role || 'user');
            let text = (msg.text || '').trim();
            
            // Garbage filter: Remove messages that are just symbols or empty
            // This fixes the issue where previous "}" bugs pollute the context
            if (!text || text.length < 2 || /^[\]{}).]+$/.test(text)) {
                continue;
            }

            if (role === lastRole && text === lastText) continue; // Skip exact duplicates

            clean.push({ role, text });
            lastRole = role;
            lastText = text;
        }

        // Keep last 30 messages
        return clean.slice(-30);
    }

    isGarbageOutput(text) {
        const trimmed = (text || '').trim();
        if (!trimmed || trimmed.length < 3) return true;
        return /^[\][]{}().\s]+$/.test(trimmed);
    }

    cleanFinalResponseText(text) {
        let clean = (text || '').trim();
        clean = clean.replace(/^[\][]{}()\s]+/, '').trim();
        while (clean && /[\]})]$/.test(clean)) {
            clean = clean.slice(0, -1).trimEnd();
        }
        return clean || text;
    }

    buildFallbackMessage(actionLog = [], lastToolResult = null, userMessage = '') {
        const normalizedResult = (result) => {
            if (typeof result === 'string') return result;
            if (result && typeof result === 'object') return JSON.stringify(result);
            return '';
        };

        if (lastToolResult) {
            return `Islem sonucu: ${normalizedResult(lastToolResult)}`;
        }

        if (actionLog.length) {
            const last = actionLog[actionLog.length - 1];
            if (last.tool === 'create_script') {
                return `Script olusturuldu: ${normalizedResult(last.result)}`;
            }
            if (last.tool === 'find_chat') {
                return `Sohbet arama sonucu: ${normalizedResult(last.result)}`;
            }
            return `Islem tamamlandi: ${normalizedResult(last.result)}`;
        }

        const trimmed = String(userMessage || '').trim();
        if (trimmed) {
            return `Talep alindi: ${trimmed}`;
        }
        return 'Asistan yaniti alinamadi, lutfen tekrar deneyin.';
    }

    getSystemPrompt() {
        const toolsDesc = Object.entries(this.tools).map(([name, t]) => {
            return `- ${name}: ${t.description} (Params: ${Object.keys(t.parameters).join(', ')})`;
        }).join('\n');

        const scriptExample = `
// Example Bot Code (message-triggered, safe + detailed)
if (msg.isFromMe) return;
if (!msg.body || !String(msg.body).trim()) return;

// If you include the trigger message separately (msg.body), avoid double-including it in history:
const history = buildHistory({ limit: 25, excludeTriggerMessage: true });
const historyText = formatHistory(history, { includeTimestamps: true });

const prompt = [
  "You are a helpful WhatsApp assistant.",
  "Write a clear, complete, and polite reply in Turkish.",
  "",
  "Conversation history (oldest -> newest, excluding the latest incoming message):",
  historyText,
  "",
  "Latest incoming message:",
  msg.fromName + ": " + msg.body
].join("\\n");

// Optional: cooldown to prevent rapid-fire loops
const key = "lastReplyAt:" + msg.chatId;
const lastReplyAt = Number(storage.get(key) || 0);
if (Date.now() - lastReplyAt < 2500) return;

const aiText = await aiGenerate(prompt, { temperature: 0.4 });
storage.set(key, Date.now());
await reply(aiText);
`;

        return `
You are the Admin Assistant for the WhatsApp Panel.
Your goal is to help the admin manage scripts and bots.

AVAILABLE TOOLS:
${toolsDesc}

RULES:
1. RESPONSE FORMAT: You must ALWAYS respond with a JSON object.
2. If you need to use a tool, set "tool_name" and "tool_params".
3. If you are done or need to talk to the user, set "final_response" and leave "tool_name" null.
4. "filter" for create_script must be a JSON string like '{"chatIds": ["123@c.us"]}'.
5. "code" for create_script must be valid JavaScript. Use 'aiGenerate' for AI features.
6. NO MARKDOWN in the JSON output. Return pure JSON.
7. "final_response" should be a clear, natural language message to the user. DO NOT return lone braces, brackets, or placeholder characters.
8. Be thorough: in "final_response", include assumptions, what you did/will do, and concrete next steps (how to test/where to click).
9. When generating scripts, prefer complete solutions: input validation, ignore self-messages, optional cooldown via storage, and readable prompts (use formatHistory).
10. If the user asks to assign an AI/bot to a chat ("... sohbetine AI/bot ata"), ask clarifying questions (persona, trigger rules, boundaries) before using create_script.

Script Code Example:
${JSON.stringify(scriptExample)}

JSON OUTPUT SCHEMA:
{
  "thought": "Internal reasoning about what to do next...",
  "tool_name": "name_of_tool" (or null),
  "tool_params": { ... } (or null),
  "final_response": "Message to user" (or null)
}
`;
    }
    
        async process(history, userMessage, userContext) {
            let currentHistory = this.normalizeHistory(history);
            const userText = String(userMessage || '').trim();
            const lastEntry = currentHistory.length ? currentHistory[currentHistory.length - 1] : null;
            const lastRole = lastEntry?.role || null;
            const lastText = typeof lastEntry?.text === 'string' ? lastEntry.text.trim() : '';

            // Avoid duplicating the last user message: the frontend often sends the
            // new message already included in `history`.
            if (userText && !(lastRole === 'user' && lastText === userText)) {
                currentHistory.push({ role: 'user', text: userText });
            }

            // Nudge the model to ask clarifying questions (persona/boundaries/trigger)
            // instead of creating a script immediately.
            this.injectAssignmentClarificationNotice(currentHistory, userText);
            const gateAssignmentTools = this.shouldGateAiAssignmentTools(currentHistory, userText);

            const maxTurns = 5; // Prevent infinite loops
            let turn = 0;
            let invalidResponses = 0;
            let assignmentToolBlocks = 0;
            let lastToolResult = null;
            const actionLog = [];

            while (turn < maxTurns) {
                turn++;
    
                // Construct prompt for this turn
                const conversation = currentHistory.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
                const prompt = `Conversation:\n${conversation}\n\nReview the history and decide the next step (Tool or Response).`;
    
                try {
                    // Generate JSON decision
                    const response = await aiService.generateJson({
                        prompt,
                        systemInstruction: this.getSystemPrompt(),
                        apiKey: userContext.apiKey,
                        provider: userContext.provider,
                        model: userContext.model,
                        temperature: 0.2 // Lower temp for precise tool usage
                    });
    
                    logger.info('AdminAgent Decision', response);
    
                    if (response.tool_name) {
                        if (gateAssignmentTools) {
                            assignmentToolBlocks += 1;
                            currentHistory.push({
                                role: 'user',
                                text: [
                                    '[SYSTEM NOTICE]',
                                    'Do not use tools yet. Ask short clarifying questions about persona/tone, when to reply (trigger), and boundaries. Wait for user answers, then proceed.'
                                ].join(' ')
                            });

                            if (assignmentToolBlocks >= 2) {
                                return 'AI atamasi yapmadan once botun karakterini/tonu, ne zaman cevap verecegini (tetik kurali) ve sinirlarini (yasak konular) netlestirelim. Bunlari yazar misin?';
                            }
                            continue;
                        }

                        // Execute Tool
                        const tool = this.tools[response.tool_name];
                        if (!tool) {
                            currentHistory.push({ 
                                role: 'assistant', 
                                text: `Attempted to use unknown tool: ${response.tool_name}` 
                            });
                            continue;
                        }
    
                        let toolResult;
                        try {
                            toolResult = await tool.execute(response.tool_params || {});
                            lastToolResult = toolResult;
                            actionLog.push({ tool: response.tool_name, result: toolResult });
                        } catch (err) {
                            toolResult = `Error executing ${response.tool_name}: ${err.message}`;
                            lastToolResult = toolResult;
                            actionLog.push({ tool: response.tool_name, result: toolResult });
                        }
    
                        // Add tool result to history as a system/observation message
                        // We model it as a user message from "SYSTEM" to inform the AI
                        currentHistory.push({
                            role: 'user', // "user" role is safer for many models than "system" in middle of convo
                            text: `[SYSTEM TOOL RESULT for ${response.tool_name}]: ${toolResult}`
                        });
    
                    } else if (response.final_response) {
                        // Validate final response
                        const text = String(response.final_response).trim();
                        if (this.isGarbageOutput(text)) {
                            logger.warn('AdminAgent produced garbage final response', { text });
                            invalidResponses += 1;
                            if (invalidResponses >= 2) {
                                return this.buildFallbackMessage(actionLog, lastToolResult, userMessage);
                            } else {
                                currentHistory.push({
                                    role: 'user',
                                    text: `[SYSTEM NOTICE]: Invalid assistant reply "${text}". Respond again with a clear sentence or use tools.`
                                });
                                continue;
                            }
                        }
                        if (text) {
                            const cleaned = this.cleanFinalResponseText(text);
                            const isStillGarbage = !cleaned || this.isGarbageOutput(cleaned);
                            if (isStillGarbage) {
                                invalidResponses += 1;
                                if (invalidResponses >= 2) {
                                    return this.buildFallbackMessage(actionLog, lastToolResult, userMessage);
                                }
                                currentHistory.push({
                                    role: 'user',
                                    text: `[SYSTEM NOTICE]: Invalid assistant reply "${cleaned}". Respond again clearly.`
                                });
                                continue;
                            }
                            return cleaned;
                        }
                        // If invalid but thought exists, return thought
                        if (response.thought) return response.thought;
                        return "I processed your request.";
                    } else {
                        // Fallback
                        if (response.thought) return response.thought;
                        return "I'm not sure what to do. No tool or response specified.";
                    }
    
                } catch (error) {
                    logger.error('AdminAgent Loop Error', error);
                    return "Internal Error: " + error.message;
                }
            }
    
            if (lastToolResult) {
                return `Islem sonucu: ${String(lastToolResult)}`;
            }
            return "Asistan yaniti alinamadi, lutfen tekrar deneyin.";
        }
    }
    module.exports = AdminAgent;
