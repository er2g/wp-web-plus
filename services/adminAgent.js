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
                description: 'Create a new script/bot. Use this to assign a bot or create a new automation.',
                parameters: {
                    name: 'Name of the script (e.g., "Pirate Bot for Mom")',
                    description: 'Short description',
                    code: 'The JavaScript code for the script. MUST be valid JS.',
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
            if (!text || text.length < 2 || /^[\}\]\{\)\.]+$/.test(text)) {
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
        if (!trimmed || trimmed.length < 2) return true;
        return /^[\]\[\{\}\(\)\.\s]+$/.test(trimmed);
    }

    getSystemPrompt() {
        const toolsDesc = Object.entries(this.tools).map(([name, t]) => {
            return `- ${name}: ${t.description} (Params: ${Object.keys(t.parameters).join(', ')})`;
        }).join('\n');

        const scriptExample = `
// Example Bot Code
if (msg.isFromMe) return;
const history = buildHistory({ limit: 10 });
const prompt = "Reply as a pirate to: " + msg.body;
const reply = await aiGenerate(prompt);
await reply(reply);
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
            currentHistory.push({ role: 'user', text: userMessage });
    
            const maxTurns = 5; // Prevent infinite loops
            let turn = 0;
    
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
                        } catch (err) {
                            toolResult = `Error executing ${response.tool_name}: ${err.message}`;
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
                            currentHistory.push({
                                role: 'user',
                                text: `[SYSTEM NOTICE]: Invalid assistant reply "${text}". Respond again with a clear sentence or use tools.`
                            });
                            continue;
                        }
                        if (text) {
                            return text;
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
    
            return "I tried to process your request but ran into a loop.";
        }
    }
    module.exports = AdminAgent;
