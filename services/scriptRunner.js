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

const SCRIPT_LIMITS = {
    // vm timeout is CPU-time-ish; async can still extend runtime, so we enforce both.
    CPU_TIMEOUT_MS: 5000,
    WALL_TIMEOUT_MS: 15000,
    MAX_LOG_LINES: 200,
    MAX_LOG_CHARS: 2000,
    MAX_TIMERS: 25,
    MAX_TIMER_DELAY_MS: 5000,
    MAX_FETCH_BYTES: 256 * 1024
};

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|session|api[_-]?key|ai[_-]?api[_-]?key|csrf|xsrf|\\bqr\\b|qr[_-]?code|qrcode|body|content|message|quoted_body|quoted_from_name|from_name|from_number|to_number|phone/i;

function redactString(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    out = out.replace(/Bearer\\s+[A-Za-z0-9._-]+/g, 'Bearer ' + REDACTED);
    out = out.replace(/(api[_-]?key\\s*[:=]\\s*)([^\\s]+)/ig, `$1${REDACTED}`);
    out = out.replace(/(password\\s*[:=]\\s*)([^\\s]+)/ig, `$1${REDACTED}`);
    if (out.length > SCRIPT_LIMITS.MAX_LOG_CHARS) {
        out = out.slice(0, SCRIPT_LIMITS.MAX_LOG_CHARS) + '…';
    }
    return out;
}

function safeStringify(value) {
    try {
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function sanitizeScriptLogText(text) {
    const raw = redactString(String(text || ''));
    return raw.length > SCRIPT_LIMITS.MAX_LOG_CHARS ? raw.slice(0, SCRIPT_LIMITS.MAX_LOG_CHARS) + '…' : raw;
}

function sanitizeScriptLogData(data) {
    if (data === null || data === undefined) return null;
    try {
        const seen = new WeakSet();
        const redactValue = (value, keyHint, depth) => {
            if (value === null || value === undefined) return value;
            if (typeof value === 'string') {
                if (keyHint && SENSITIVE_KEY.test(keyHint)) return REDACTED;
                return redactString(value);
            }
            if (typeof value !== 'object') return value;
            if (seen.has(value) || depth > 6) return '[Truncated]';
            seen.add(value);
            if (Array.isArray(value)) return value.slice(0, 50).map(v => redactValue(v, keyHint, depth + 1));
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, k, depth + 1);
            }
            return out;
        };

        const sanitized = typeof data === 'string' ? redactString(data) : redactValue(data, null, 0);
        const json = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
        return json.length > SCRIPT_LIMITS.MAX_LOG_CHARS ? json.slice(0, SCRIPT_LIMITS.MAX_LOG_CHARS) + '…' : json;
    } catch (e) {
        return sanitizeScriptLogText(String(data));
    }
}

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
    constructor(db, whatsapp) {
        this.db = db;
        this.whatsapp = whatsapp;
        this.runningScripts = new Map();
        this.warnedMissingScope = new Set();
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
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
        const userAi = this.db?.users?.getFirstAiConfig?.get?.();

        const rawApiKey = (typeof overrides.apiKey === 'string' ? overrides.apiKey.trim() : '')
            || (typeof filterAi.apiKey === 'string' ? filterAi.apiKey.trim() : '')
            || (typeof userAi?.apiKey === 'string' ? userAi.apiKey.trim() : '')
            || (typeof aiService.apiKey === 'string' ? aiService.apiKey.trim() : '');

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
            : 1024;

        const tempCandidate = overrides.temperature ?? filterAi.temperature;
        const tempParsed = Number.parseFloat(String(tempCandidate ?? ''));
        const temperature = Number.isFinite(tempParsed)
            ? Math.max(0, Math.min(1, tempParsed))
            : 0.3;

        return {
            apiKey: rawApiKey || null,
            model,
            maxTokens,
            temperature
        };
    }

    // Create sandboxed context for script execution
    createContext(script, triggerData) {
        const self = this;
        const scriptId = script?.id || 0;
        let logLines = 0;
        let timerCount = 0;
        
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
                    return await self.whatsapp.sendMessage(targetChatId, message);
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
                    return await self.whatsapp.sendMessage(triggerData.chatId, message);
                },
                writable: false, configurable: false
            },

            // Data access
            getChats: {
                value: () => self.db.chats.getAll.all(),
                writable: false, configurable: false
            },
            getMessages: {
                value: (chatId, limit = 50) => self.db.messages.getByChatId.all(chatId, limit),
                writable: false, configurable: false
            },
            searchMessages: {
                value: (query) => self.db.messages.search.all('%' + query + '%'),
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
                    log: (...args) => {
                        if (logLines++ > SCRIPT_LIMITS.MAX_LOG_LINES) return;
                        self.scriptLog(scriptId, 'info', sanitizeScriptLogText(args.map(safeStringify).join(' ')));
                    },
                    info: (...args) => {
                        if (logLines++ > SCRIPT_LIMITS.MAX_LOG_LINES) return;
                        self.scriptLog(scriptId, 'info', sanitizeScriptLogText(args.map(safeStringify).join(' ')));
                    },
                    warn: (...args) => {
                        if (logLines++ > SCRIPT_LIMITS.MAX_LOG_LINES) return;
                        self.scriptLog(scriptId, 'warn', sanitizeScriptLogText(args.map(safeStringify).join(' ')));
                    },
                    error: (...args) => {
                        if (logLines++ > SCRIPT_LIMITS.MAX_LOG_LINES) return;
                        self.scriptLog(scriptId, 'error', sanitizeScriptLogText(args.map(safeStringify).join(' ')));
                    }
                }),
                writable: false, configurable: false
            },

            log: {
                value: (...args) => {
                    if (logLines++ > SCRIPT_LIMITS.MAX_LOG_LINES) return;
                    self.scriptLog(scriptId, 'info', sanitizeScriptLogText(args.map(safeStringify).join(' ')));
                },
                writable: false, configurable: false
            },

            // Storage
            storage: {
                value: {
                    _data: {},
                    get: function(key) { return this._data[key]; },
                    set: function(key, value) { this._data[key] = value; },
                    delete: function(key) { delete this._data[key]; },
                    clear: function() { this._data = {}; }
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
                        const method = String(options.method || 'GET').toUpperCase();
                        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                            throw new Error('Unsupported method');
                        }
                        const body = options.body;
                        const bodyText = body === undefined || body === null ? undefined : (typeof body === 'string' ? body : safeStringify(body));
                        if (bodyText && Buffer.byteLength(bodyText) > SCRIPT_LIMITS.MAX_FETCH_BYTES) {
                            throw new Error('Body too large');
                        }
                        const response = await axios({
                            url,
                            method,
                            headers: options.headers,
                            data: bodyText,
                            timeout: 10000,
                            maxContentLength: SCRIPT_LIMITS.MAX_FETCH_BYTES,
                            maxBodyLength: SCRIPT_LIMITS.MAX_FETCH_BYTES,
                            responseType: 'json',
                            validateStatus: () => true
                        });
                        const jsonText = safeStringify(response.data);
                        const truncated = jsonText.length > SCRIPT_LIMITS.MAX_FETCH_BYTES
                            ? jsonText.slice(0, SCRIPT_LIMITS.MAX_FETCH_BYTES) + '…'
                            : jsonText;
                        return {
                            ok: response.status >= 200 && response.status < 300,
                            status: response.status,
                            json: async () => response.data,
                            text: async () => truncated
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            status: error.response?.status || 0,
                            json: async () => ({}),
                            text: async () => sanitizeScriptLogText(error.message)
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
                        model: resolved.model,
                        maxOutputTokens: resolved.maxTokens,
                        temperature: resolved.temperature
                    });
                },
                writable: false, configurable: false
            },

            // Timing
            setTimeout: {
                value: (fn, ms) => {
                    if (timerCount++ > SCRIPT_LIMITS.MAX_TIMERS) {
                        throw new Error('Timer limit exceeded');
                    }
                    const delay = Math.max(0, Math.min(Number(ms) || 0, SCRIPT_LIMITS.MAX_TIMER_DELAY_MS));
                    return setTimeout(fn, delay);
                },
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
            this.db.scriptLogs.add.run(scriptId, level, sanitizeScriptLogText(message), null);
        } catch (e) {
            logger.error('Script log error', { category: 'script-runner', error: e.message });
        }
    }

    scriptLogWithData(scriptId, level, message, data) {
        try {
            const payload = data ? sanitizeScriptLogData(data) : null;
            this.db.scriptLogs.add.run(scriptId, level, sanitizeScriptLogText(message), payload);
        } catch (e) {
            console.error('Script log error:', e);
        }
    }

    async runScript(script, triggerData = null) {
        const startTime = Date.now();

        try {
            const context = this.createContext(script, triggerData);
            vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });

            // Wrap code in async function to support await
            const wrappedCode = `
                (async () => {
                    ${script.code}
                })()
            `;

            const scriptObj = new vm.Script(wrappedCode, {
                filename: script.name + '.js'
            });

            const exec = scriptObj.runInContext(context, { timeout: SCRIPT_LIMITS.CPU_TIMEOUT_MS });
            await Promise.race([
                exec,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Script timeout')), SCRIPT_LIMITS.WALL_TIMEOUT_MS))
            ]);

            this.db.scripts.recordRun.run(script.id);

            const duration = Date.now() - startTime;
            this.scriptLog(script.id, 'info', 'Script completed in ' + duration + 'ms');

            return { success: true, duration };

        } catch (error) {
            this.db.scripts.recordError.run(error.message, script.id);
            this.scriptLogWithData(script.id, 'error', 'Error: ' + error.message, {
                script_id: script.id,
                stack: sanitizeScriptLogText(error.stack || ''),
                trigger: triggerData ? { messageId: triggerData.messageId, chatId: triggerData.chatId } : null
            });

            return { success: false, error: error.message };
        }
    }

    async processMessage(msgData) {
        if (!msgData) return;

        if (typeof this.db?.crypto?.isUnlocked === 'function' && !this.db.crypto.isUnlocked()) {
            return;
        }

        if (typeof msgData.body !== 'string') {
            return;
        }

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

function createScriptRunner(db, whatsapp) {
    return new ScriptRunner(db, whatsapp);
}

module.exports = { createScriptRunner };
