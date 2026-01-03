const aiService = require('./aiService');
const { logger } = require('./logger');

/**
 * Admin Agent Service
 * Handles natural language requests to manage the system (scripts, bots, etc.)
 */

class AdminAgent {
    constructor(db) {
        this.db = db;
        this.tools = this.defineTools();
    }

    defineTools() {
        return {
            find_chat: {
                description: 'Search for a chat by name to get its ID. Use this when the user mentions a chat name.',
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
                    code: 'The JavaScript code for the script',
                    filter: 'JSON string for trigger_filter (e.g., {"chatIds": ["..."]})'
                },
                execute: async ({ name, description, code, filter }) => {
                    try {
                        const res = this.db.scripts.create.run(
                            name,
                            description || '',
                            code,
                            'message',
                            typeof filter === 'string' ? filter : JSON.stringify(filter),
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

    createSystemPrompt() {
        const codeExample = [
            "// Get history",
            "const history = getMessages(msg.chatId, 50).reverse().map(m => (m.isFromMe ? 'Me: ' : 'User: ') + m.body).join('\n');",
            "",
            "// Generate reply",
            "const prompt = `You are a helpful assistant...\n\nHistory:\n${history}\n\nUser: ${msg.body}`,",
            "",
            "const replyText = await aiGenerate(prompt);",
            "await reply(replyText);"
        ].join('\n');

        return `
You are the Admin Assistant for a WhatsApp Automation Panel.
You have access to tools to manage the system.

Your primary goal is to help the user manage "Scripts" and "Bots".
A "Bot" is simply a Script that triggers on 'message' events for a specific chat.

AVAILABLE TOOLS:
1. find_chat(query): Finds chat IDs by name. ALWAYS use this if the user gives a name instead of an ID.
2. create_script(name, description, code, filter): Creates a script.
   - 'code' must be JavaScript that runs in the 'scriptRunner' context.
   - 'filter' is a JSON object like {"chatIds": ["123@c.us"]}.
   - Common script pattern for bots:
     \
     \
     ${codeExample}
     \
     \
3. list_scripts(): Lists active scripts.
4. delete_script(id): Deletes a script.

INSTRUCTIONS:
- If the user asks to "Assign a bot to chat X", first call 'find_chat("X")'.
- Once you have the Chat ID, call 'create_script' with the appropriate code and filter.
- If the user asks for a specific persona (e.g. "Pirate"), adjust the prompt in the code.
- If the user asks to "Look at the last N messages", adjust the 'getMessages(msg.chatId, N)' call in the code.
- When you use a tool, respond with "TOOL_CALL: tool_name {json_params}".
- I will respond with "TOOL_RESULT: result".
- Then you continue the conversation.
- If no tool is needed, just reply normally.
`;
    }

    async process(history, userMessage, userContext) {
        let messages = [...history];
        if (userMessage) {
            messages.push({ role: 'user', text: userMessage });
        }

        const systemPrompt = this.createSystemPrompt();
        
        // Context injection
        const fullPrompt = `${systemPrompt}\n\nConversation History:\n${messages.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n')}\n\nAssistant:`;

        try {
            // 1. Get initial response
            let responseText = await aiService.generateText({
                prompt: fullPrompt,
                apiKey: userContext.apiKey,
                provider: userContext.provider,
                model: userContext.model || 'gemini-2.5-flash'
            });

            // 2. Check for tool call
            const toolCallMatch = responseText.match(/TOOL_CALL: (\w+) ({.*})/s);
            
            if (toolCallMatch) {
                const toolName = toolCallMatch[1];
                const paramsStr = toolCallMatch[2];
                
                const tool = this.tools[toolName];
                if (tool) {
                    let result = '';
                    try {
                        const params = JSON.parse(paramsStr);
                        result = await tool.execute(params);
                    } catch (e) {
                        result = `Error executing tool: ${e.message}`;
                    }

                    // 3. Feed result back to AI
                    const followUpPrompt = `${fullPrompt}${responseText}\nTOOL_RESULT: ${result}\nAssistant (interpret result and reply to user):`;
                    
                    const finalResponse = await aiService.generateText({
                        prompt: followUpPrompt,
                        apiKey: userContext.apiKey,
                        provider: userContext.provider,
                        model: userContext.model || 'gemini-2.5-flash'
                    });

                    return finalResponse;
                }
            }

            return responseText;

        } catch (error) {
            logger.error('Admin Agent Error', error);
            return "Sorry, I encountered an error processing your request: " + error.message;
        }
    }
}

module.exports = AdminAgent;
