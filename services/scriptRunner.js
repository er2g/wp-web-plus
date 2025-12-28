/**
 * WhatsApp Web Panel - Script Runner Service
 * Executes user scripts in a sandboxed environment
 */
const vm = require('vm');

class ScriptRunner {
    constructor(db, whatsapp) {
        this.db = db;
        this.whatsapp = whatsapp;
        this.runningScripts = new Map();
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
    }

    // Create sandboxed context for script execution
    createContext(scriptId, triggerData) {
        const self = this;

        return {
            // Messaging
            sendMessage: async (chatId, message) => {
                if (!self.whatsapp || !self.whatsapp.isReady()) {
                    throw new Error('WhatsApp not connected');
                }
                return await self.whatsapp.sendMessage(chatId, message);
            },

            reply: async (message) => {
                if (!triggerData || !triggerData.chatId) {
                    throw new Error('No chat context for reply');
                }
                return await self.whatsapp.sendMessage(triggerData.chatId, message);
            },

            // Data access
            getChats: () => self.db.chats.getAll.all(),
            getMessages: (chatId, limit = 50) => self.db.messages.getByChatId.all(chatId, limit),
            searchMessages: (query) => self.db.messages.search.all('%' + query + '%'),

            // Trigger data
            msg: triggerData,
            message: triggerData,

            // Utilities
            console: {
                log: (...args) => self.scriptLog(scriptId, 'info', args.join(' ')),
                info: (...args) => self.scriptLog(scriptId, 'info', args.join(' ')),
                warn: (...args) => self.scriptLog(scriptId, 'warn', args.join(' ')),
                error: (...args) => self.scriptLog(scriptId, 'error', args.join(' '))
            },

            log: (...args) => self.scriptLog(scriptId, 'info', args.join(' ')),

            // Storage (simple key-value per script)
            storage: {
                _data: {},
                get: function(key) { return this._data[key]; },
                set: function(key, value) { this._data[key] = value; },
                delete: function(key) { delete this._data[key]; },
                clear: function() { this._data = {}; }
            },

            // HTTP requests
            fetch: async (url, options = {}) => {
                const axios = require('axios');
                try {
                    const response = await axios({
                        url,
                        method: options.method || 'GET',
                        headers: options.headers,
                        data: options.body,
                        timeout: 10000
                    });
                    return {
                        ok: response.status >= 200 && response.status < 300,
                        status: response.status,
                        json: async () => response.data,
                        text: async () => JSON.stringify(response.data)
                    };
                } catch (error) {
                    return {
                        ok: false,
                        status: error.response?.status || 0,
                        json: async () => ({}),
                        text: async () => error.message
                    };
                }
            },

            // Timing
            setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30000)), // Max 30 sec
            setInterval: null, // Disabled for safety

            // Date/Time
            Date,

            // JSON
            JSON,

            // Math
            Math,

            // String/Array utilities
            String,
            Array,
            Object,
            parseInt,
            parseFloat,
            isNaN,

            // Regex
            RegExp
        };
    }

    scriptLog(scriptId, level, message) {
        try {
            this.db.scriptLogs.add.run(scriptId, level, message, null);
        } catch (e) {
            console.error('Script log error:', e);
        }
    }

    scriptLogWithData(scriptId, level, message, data) {
        try {
            const payload = data ? JSON.stringify(data) : null;
            this.db.scriptLogs.add.run(scriptId, level, message, payload);
        } catch (e) {
            console.error('Script log error:', e);
        }
    }

    async runScript(script, triggerData = null) {
        const startTime = Date.now();

        try {
            const context = this.createContext(script.id, triggerData);
            vm.createContext(context);

            // Wrap code in async function to support await
            const wrappedCode = `
                (async () => {
                    ${script.code}
                })()
            `;

            const scriptObj = new vm.Script(wrappedCode, {
                filename: script.name + '.js',
                timeout: 30000 // 30 second timeout
            });

            await scriptObj.runInContext(context, {
                timeout: 30000
            });

            this.db.scripts.recordRun.run(script.id);

            const duration = Date.now() - startTime;
            this.scriptLog(script.id, 'info', 'Script completed in ' + duration + 'ms');

            return { success: true, duration };

        } catch (error) {
            this.db.scripts.recordError.run(error.message, script.id);
            this.scriptLogWithData(script.id, 'error', 'Error: ' + error.message, {
                script_id: script.id,
                stack: error.stack,
                trigger_data: triggerData
            });

            return { success: false, error: error.message };
        }
    }

    async processMessage(msgData) {
        if (!msgData) return;

        const scripts = this.db.scripts.getByTrigger.all('message');

        for (const script of scripts) {
            try {
                // Check filter if exists
                if (script.trigger_filter) {
                    const filter = JSON.parse(script.trigger_filter);

                    // Filter by sender
                    if (filter.from && !msgData.from.includes(filter.from)) continue;

                    // Filter by content
                    if (filter.contains && !msgData.body.toLowerCase().includes(filter.contains.toLowerCase())) continue;

                    // Filter by regex
                    if (filter.regex) {
                        const regex = new RegExp(filter.regex, 'i');
                        if (!regex.test(msgData.body)) continue;
                    }

                    // Filter: only incoming
                    if (filter.incoming === true && msgData.isFromMe) continue;

                    // Filter: only outgoing
                    if (filter.outgoing === true && !msgData.isFromMe) continue;

                    // Filter: only groups
                    if (filter.groupOnly === true && !msgData.isGroup) continue;

                    // Filter: only private
                    if (filter.privateOnly === true && msgData.isGroup) continue;
                }

                await this.runScript(script, msgData);

            } catch (error) {
                console.error('Script filter error:', error);
            }
        }
    }

    async testScript(code, testData = {}) {
        const fakeScript = { id: 0, name: 'test', code };
        return await this.runScript(fakeScript, testData);
    }
}

function createScriptRunner(db, whatsapp) {
    return new ScriptRunner(db, whatsapp);
}

module.exports = { createScriptRunner };
