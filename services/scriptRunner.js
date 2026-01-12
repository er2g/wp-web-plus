/**
 * WhatsApp Web Panel - Script Runner Service
 * Executes user scripts in a sandboxed environment
 */
const vm = require('vm');
const { logger } = require('./logger');
const { isSafeExternalUrl } = require('../lib/urlSafety');
const aiService = require('./aiService');

const AI_DEPRECATED_MODELS = new Set(['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash']);
const AI_DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveAiModel(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        if (AI_DEPRECATED_MODELS.has(trimmed)) continue;
        return trimmed;
    }
    const fallback = aiService.model || AI_DEFAULT_MODEL;
    if (typeof fallback === 'string' && fallback.trim() && !AI_DEPRECATED_MODELS.has(fallback.trim())) {
        return fallback.trim();
    }
    return AI_DEFAULT_MODEL;
}

class ScriptRunner {
    constructor(db, whatsapp, options = {}) {
        this.db = db;
        this.whatsapp = whatsapp;
        this.runningScripts = new Map();
        this.warnedMissingScope = new Set();
        this.aiConfigProvider = typeof options.aiConfigProvider === 'function' ? options.aiConfigProvider : null;
        this.scriptStorage = new Map();
        this.botMessageRegistry = new Map(); // messageId -> { chatId, ts, body }
        this.botMessageFallback = new Map(); // chatId -> [{ body, ts }]
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
    }

    trackBotSend(result, chatId, body) {
        const now = Date.now();
        const msgId = result?.id?._serialized || result?.id || result?._serialized || null;
        if (msgId) {
            this.botMessageRegistry.set(msgId, { chatId, ts: now, body: String(body || '') });
            if (this.botMessageRegistry.size > 500) {
                // Trim oldest roughly by timestamp
                const entries = Array.from(this.botMessageRegistry.entries()).sort((a, b) => a[1].ts - b[1].ts);
                for (let i = 0; i < 100 && entries.length; i++) {
                    const [key] = entries.shift();
                    this.botMessageRegistry.delete(key);
                }
            }
        } else {
            const key = String(chatId || '');
            const list = this.botMessageFallback.get(key) || [];
            list.push({ body: String(body || ''), ts: now });
            if (list.length > 50) list.shift();
            this.botMessageFallback.set(key, list);
        }
    }

    isBotMessage(row) {
        const messageId = row.message_id || row.messageId || row.id;
        if (messageId && this.botMessageRegistry.has(messageId)) return true;
        const chatId = row.chat_id || row.chatId || '';
        const body = (row.body || '').trim();
        if (!body) return false;
        const candidates = this.botMessageFallback.get(String(chatId)) || [];
        const ts = Number(row.timestamp) || Date.now();
        const matched = candidates.find(item => item.body === body && Math.abs(ts - item.ts) < 8000);
        return Boolean(matched);
    }

    getRecentMessages(chatId, limit = 50, offset = 0) {
        const safeLimit = Math.max(1, Math.min(200, Number.parseInt(String(limit ?? 50), 10) || 50));
        const safeOffset = Math.max(0, Number.parseInt(String(offset ?? 0), 10) || 0);
        try {
            return this.db.messages.getByChatId.all(chatId, safeLimit, safeOffset);
        } catch (e) {
            return [];
        }
    }

    getSharedAiConfig() {
        if (typeof this.aiConfigProvider !== 'function') return null;
        try {
            const result = this.aiConfigProvider();
            return result && typeof result === 'object' ? result : null;
        } catch (e) {
            return null;
        }
    }

    getStorageBucket(scriptId) {
        const parsed = Number.parseInt(String(scriptId ?? '0'), 10);
        const id = Number.isFinite(parsed) ? parsed : 0;
        if (!this.scriptStorage.has(id)) {
            this.scriptStorage.set(id, new Map());
        }
        return this.scriptStorage.get(id);
    }

    parseTriggerFilter(script) {
        if (!script || !script.trigger_filter) return null;
        if (typeof script.trigger_filter !== 'string') return null;
        try {
            const parsed = JSON.parse(script.trigger_filter);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    getAllowedChatIds(script) {
        const triggerType = script?.trigger_type || 'message';
        const filter = this.parseTriggerFilter(script);
        const raw = filter?.chatIds ?? filter?.chat_ids;
        if (raw === undefined || raw === null) {
            return triggerType === 'message' ? [] : null;
        }
        const list = Array.isArray(raw) ? raw : [raw];
        const normalized = list
            .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
            .filter(Boolean);
        return Array.from(new Set(normalized));
    }

    getAiSettings(script) {
        const filter = this.parseTriggerFilter(script);
        const candidate = filter?.ai;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
        return candidate;
    }

    resolveAiConfig(script, overrides = {}) {
        const filterAi = this.getAiSettings(script);
        const localAi = this.db?.users?.getFirstAiConfig?.get?.();
        const sharedAi = this.getSharedAiConfig();
        const userAi = localAi || sharedAi;

        const provider = (typeof overrides.provider === 'string' ? overrides.provider.trim() : '')
            || (typeof filterAi.provider === 'string' ? filterAi.provider.trim() : '')
            || (typeof userAi?.provider === 'string' ? userAi.provider.trim() : '')
            || (typeof aiService.provider === 'string' ? aiService.provider.trim() : 'gemini');

        const fallbackServiceKey = provider.toLowerCase() === 'vertex'
            ? (typeof aiService.vertexApiKey === 'string' ? aiService.vertexApiKey.trim() : '')
            : (typeof aiService.apiKey === 'string' ? aiService.apiKey.trim() : '');

        const rawApiKey = (typeof overrides.apiKey === 'string' ? overrides.apiKey.trim() : '')
            || (typeof filterAi.apiKey === 'string' ? filterAi.apiKey.trim() : '')
            || (typeof userAi?.apiKey === 'string' ? userAi.apiKey.trim() : '')
            || fallbackServiceKey;

        const model = resolveAiModel(
            overrides.model,
            filterAi.model,
            userAi?.model,
            aiService.model
        );

        const maxTokensCandidate = overrides.maxTokens ?? filterAi.maxTokens ?? userAi?.maxTokens;
        const maxTokensParsed = Number.parseInt(String(maxTokensCandidate ?? ''), 10);
        const maxTokens = Number.isFinite(maxTokensParsed)
            ? Math.max(256, Math.min(8192, maxTokensParsed))
            : 4096;

        const tempCandidate = overrides.temperature ?? filterAi.temperature;
        const tempParsed = Number.parseFloat(String(tempCandidate ?? ''));
        const temperature = Number.isFinite(tempParsed)
            ? Math.max(0, Math.min(1, tempParsed))
            : 0.3;

        return {
            apiKey: rawApiKey || null,
            provider,
            model,
            maxTokens,
            temperature
        };
    }

    // Create sandboxed context for script execution
    createContext(script, triggerData) {
        const self = this;
        const scriptId = script?.id || 0;
        
        // Create a null-prototype object to prevent prototype chain attacks
        const context = Object.create(null);
        const allowedChatIds = self.getAllowedChatIds(script);
        const allowedChatSet = Array.isArray(allowedChatIds) ? new Set(allowedChatIds) : null;

        // Define properties directly on the null-prototype object
        Object.defineProperties(context, {
            // Messaging
            sendMessage: {
                value: async (chatId, message) => {
                    const targetChatId = typeof chatId === 'string' ? chatId.trim() : '';
                    if (!targetChatId) {
                        throw new Error('chatId gerekli');
                    }
                    if (allowedChatSet && !allowedChatSet.has(targetChatId)) {
                        throw new Error('Kapsam engeli: Bu script sadece secilen sohbetlere mesaj gonderebilir');
                    }
                    if (!self.whatsapp || !self.whatsapp.isReady()) {
                        throw new Error('WhatsApp not connected');
                    }
                    const result = await self.whatsapp.sendMessage(targetChatId, message);
                    self.trackBotSend(result, targetChatId, message);
                    return result;
                },
                writable: false, configurable: false
            },

            reply: {
                value: async (message) => {
                    if (!triggerData || !triggerData.chatId) {
                        throw new Error('No chat context for reply');
                    }
                    if (allowedChatSet && !allowedChatSet.has(triggerData.chatId)) {
                        throw new Error('Kapsam engeli: Bu sohbete yanit gonderilemez');
                    }
                    const result = await self.whatsapp.sendMessage(triggerData.chatId, message);
                    self.trackBotSend(result, triggerData.chatId, message);
                    return result;
                },
                writable: false, configurable: false
            },

            // Data access
            getChats: {
                value: () => self.db.chats.getAll.all(),
                writable: false, configurable: false
            },
            getMessages: {
                value: (chatId, limit = 50, offset = 0) => self.getRecentMessages(chatId, limit, offset),
                writable: false, configurable: false
            },
            searchMessages: {
                value: (query) => self.db.messages.search.all('%' + query + '%'),
                writable: false, configurable: false
            },

            buildHistory: {
                value: (options = {}) => {
                    const chatId = options.chatId || triggerData?.chatId;
                    if (!chatId) return [];
                    const limit = Math.max(1, Math.min(200, Number.parseInt(String(options.limit ?? 40), 10) || 40));
                    const rows = self.getRecentMessages(chatId, limit, 0).slice().reverse();
                    const botLabel = options.botLabel || 'Bot';
                    const userLabel = options.userLabel || 'Kullanici';
                    const peerLabel = options.peerLabel || 'Karsi';
                    const excludeMessageIds = new Set();
                    const excludeTriggerMessage = options.excludeTriggerMessage === true;
                    const dedupe = options.dedupe !== false;

                    const normalizeExcludeList = (value) => {
                        if (!value) return [];
                        if (Array.isArray(value)) return value;
                        return [value];
                    };

                    for (const candidate of normalizeExcludeList(options.excludeMessageIds)) {
                        const id = typeof candidate === 'string' ? candidate.trim() : '';
                        if (id) excludeMessageIds.add(id);
                    }
                    if (excludeTriggerMessage) {
                        const id = typeof triggerData?.messageId === 'string' ? triggerData.messageId.trim() : '';
                        if (id) excludeMessageIds.add(id);
                    }

                    const seenIds = new Set();
                    const seenFingerprints = new Set();
                    return rows.map((row) => {
                        const messageId = typeof row.message_id === 'string' ? row.message_id : null;
                        if (messageId && excludeMessageIds.has(messageId)) return null;
                        if (dedupe && messageId && seenIds.has(messageId)) return null;
                        if (dedupe && messageId) seenIds.add(messageId);

                        const isFromMe = row.is_from_me === 1 || row.isFromMe === 1 || row.isFromMe === true;
                        if (dedupe) {
                            const body = String(row.body || '').trim();
                            const fromNumber = String(row.from_number || row.fromNumber || '').trim();
                            const type = String(row.type || '').trim();
                            const timestamp = Number(row.timestamp) || 0;
                            const fingerprint = `${isFromMe ? 1 : 0}|${fromNumber}|${type}|${timestamp}|${body.slice(0, 500)}`;
                            if (seenFingerprints.has(fingerprint)) return null;
                            seenFingerprints.add(fingerprint);
                        }

                        const isBot = isFromMe && self.isBotMessage(row);
                        const role = isBot ? 'BOT' : (isFromMe ? 'USER' : 'PEER');
                        const sender = isBot
                            ? botLabel
                            : (isFromMe ? userLabel : (row.from_name || row.fromName || peerLabel));
                        return {
                            role,
                            sender,
                            text: row.body || '',
                            timestamp: row.timestamp || Date.now(),
                            chatId: row.chat_id || chatId,
                            isFromMe,
                            raw: row
                        };
                    }).filter(Boolean);
                },
                writable: false, configurable: false
            },

            formatHistory: {
                value: (history = [], options = {}) => {
                    const includeTimestamps = options.includeTimestamps !== false;
                    return history.map((entry, idx) => {
                        const date = entry.timestamp ? new Date(entry.timestamp) : null;
                        const timePart = includeTimestamps && date
                            ? `[${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}] `
                            : '';
                        const indexPart = options.includeIndex ? `${idx + 1}. ` : '';
                        return `${indexPart}${timePart}${entry.sender} (${entry.role}): ${entry.text}`;
                    }).join('\n');
                },
                writable: false, configurable: false
            },

            // Trigger data
            msg: { value: triggerData, writable: false, configurable: false },
            message: { value: triggerData, writable: false, configurable: false },
            allowedChats: {
                value: Array.isArray(allowedChatIds) ? Object.freeze([...allowedChatIds]) : Object.freeze([]),
                writable: false,
                configurable: false
            },

            // Utilities
            console: {
                value: Object.freeze({
                    log: (...args) => self.scriptLog(scriptId, 'info', args.join(' ')),
                    info: (...args) => self.scriptLog(scriptId, 'info', args.join(' ')),
                    warn: (...args) => self.scriptLog(scriptId, 'warn', args.join(' ')),
                    error: (...args) => self.scriptLog(scriptId, 'error', args.join(' '))
                }),
                writable: false, configurable: false
            },

            log: {
                value: (...args) => self.scriptLog(scriptId, 'info', args.join(' ')),
                writable: false, configurable: false
            },

            // Storage
            storage: {
                value: {
                    get: function(key) {
                        const storageKey = typeof key === 'string' ? key : String(key || '');
                        if (!storageKey) return undefined;
                        return self.getStorageBucket(scriptId).get(storageKey);
                    },
                    set: function(key, value) {
                        const storageKey = typeof key === 'string' ? key : String(key || '');
                        if (!storageKey) return;
                        self.getStorageBucket(scriptId).set(storageKey, value);
                    },
                    delete: function(key) {
                        const storageKey = typeof key === 'string' ? key : String(key || '');
                        if (!storageKey) return;
                        self.getStorageBucket(scriptId).delete(storageKey);
                    },
                    clear: function() {
                        self.getStorageBucket(scriptId).clear();
                    }
                },
                writable: false, configurable: false
            },

            // HTTP requests
            fetch: {
                value: async (url, options = {}) => {
                    const axios = require('axios');
                    if (!isSafeExternalUrl(url, { maxLength: 2048 })) {
                        return {
                            ok: false,
                            status: 0,
                            json: async () => ({}),
                            text: async () => 'Blocked URL'
                        };
                    }
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
                writable: false, configurable: false
            },

            aiGenerate: {
                value: async (prompt, options = {}) => {
                    const textPrompt = String(prompt || '').trim();
                    if (!textPrompt) {
                        throw new Error('Prompt is required');
                    }
                    const resolved = self.resolveAiConfig(script, options || {});
                    if (!resolved.apiKey) {
                        throw new Error('AI API key is not configured');
                    }
                    return await aiService.generateText({
                        prompt: textPrompt,
                        apiKey: resolved.apiKey,
                        provider: resolved.provider,
                        model: resolved.model,
                        maxOutputTokens: resolved.maxTokens,
                        temperature: resolved.temperature
                    });
                },
                writable: false, configurable: false
            },

            // Timing
            setTimeout: {
                value: (fn, ms) => setTimeout(fn, Math.min(ms, 30000)),
                writable: false, configurable: false
            },
            
            // Safe Globals
            Date: { value: Date, writable: false, configurable: false },
            JSON: { value: JSON, writable: false, configurable: false },
            Math: { value: Math, writable: false, configurable: false },
            String: { value: String, writable: false, configurable: false },
            Number: { value: Number, writable: false, configurable: false },
            Boolean: { value: Boolean, writable: false, configurable: false },
            Array: { value: Array, writable: false, configurable: false },
            Object: { value: Object, writable: false, configurable: false },
            parseInt: { value: parseInt, writable: false, configurable: false },
            parseFloat: { value: parseFloat, writable: false, configurable: false },
            isNaN: { value: isNaN, writable: false, configurable: false },
            RegExp: { value: RegExp, writable: false, configurable: false }
        });

        return context;
    }

    scriptLog(scriptId, level, message) {
        try {
            this.db.scriptLogs.add.run(scriptId, level, message, null);
        } catch (e) {
            logger.error('Script log error', { category: 'script-runner', error: e.message });
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
            const context = this.createContext(script, triggerData);
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
                const filter = this.parseTriggerFilter(script);
                const chatIds = this.getAllowedChatIds(script);
                if (!Array.isArray(chatIds) || chatIds.length === 0) {
                    if (!this.warnedMissingScope.has(script.id)) {
                        this.warnedMissingScope.add(script.id);
                        this.scriptLog(script.id, 'warn', 'Script hedef sohbet secilmedigi icin calistirilmadi');
                    }
                    continue;
                }

                if (!chatIds.includes(msgData.chatId)) {
                    continue;
                }

                // Check filter if exists
                if (filter) {
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
                logger.error('Script filter error', { category: 'script-runner', error: error.message });
            }
        }
    }

    async testScript(code, testData = {}) {
        const fakeScript = { id: 0, name: 'test', code };
        return await this.runScript(fakeScript, testData);
    }
}

function createScriptRunner(db, whatsapp, options = {}) {
    return new ScriptRunner(db, whatsapp, options);
}

module.exports = { createScriptRunner };
