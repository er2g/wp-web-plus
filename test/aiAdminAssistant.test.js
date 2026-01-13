const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-panel-ai-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tempDir;
process.env.LOGS_DIR = path.join(tempDir, 'logs');
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.ADMIN_BOOTSTRAP_USERNAME = 'admin';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'test-password';
process.env.ENABLE_BACKGROUND_JOBS = 'false';
process.env.LOG_LEVEL = 'error';
process.env.GEMINI_API_KEY = 'test-ai-key';

const { createApp } = require('../appFactory');
const accountManager = require('../services/accountManager');
const aiService = require('../services/aiService');

let appInstance;
let server;
let port;
let defaultContext;
const originalGenerateJson = aiService.generateJson;

function createClient() {
    const cookieJar = new Map();

    function ingestSetCookie(setCookieHeader) {
        if (!setCookieHeader) return;
        const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        for (const value of values) {
            const pair = value.split(';')[0];
            const idx = pair.indexOf('=');
            if (idx === -1) continue;
            const name = pair.slice(0, idx).trim();
            const cookieValue = pair.slice(idx + 1);
            cookieJar.set(name, cookieValue);
        }
    }

    function cookieHeader() {
        if (cookieJar.size === 0) return '';
        return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    function request({ method, urlPath, body, rawBody, headers }) {
        return new Promise((resolve, reject) => {
            const payload = rawBody !== undefined
                ? String(rawBody)
                : (body ? JSON.stringify(body) : null);
            const payloadHeaders = {};
            if (payload) {
                const headerKeys = Object.keys(headers || {});
                const hasContentType = headerKeys.some(key => key.toLowerCase() === 'content-type');
                if (!hasContentType) {
                    payloadHeaders['Content-Type'] = 'application/json';
                }
                payloadHeaders['Content-Length'] = Buffer.byteLength(payload);
            }
            const req = http.request(
                {
                    method,
                    hostname: '127.0.0.1',
                    port,
                    path: urlPath,
                    headers: {
                        ...(headers || {}),
                        ...payloadHeaders,
                        ...(cookieJar.size ? { Cookie: cookieHeader() } : {})
                    }
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        ingestSetCookie(res.headers['set-cookie']);
                        resolve({
                            status: res.statusCode || 0,
                            headers: res.headers,
                            body: data
                        });
                    });
                }
            );

            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    async function refreshCsrfToken() {
        await request({ method: 'GET', urlPath: '/auth/check' });
        return cookieJar.get('XSRF-TOKEN');
    }

    async function login(username, password) {
        const csrfToken = await refreshCsrfToken();
        return request({
            method: 'POST',
            urlPath: '/auth/login',
            headers: csrfToken ? { 'X-XSRF-TOKEN': csrfToken } : {},
            body: { username, password }
        });
    }

    async function api(method, urlPath, body) {
        const headers = {};
        if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) {
            const csrfToken = await refreshCsrfToken();
            if (csrfToken) {
                headers['X-CSRF-Token'] = csrfToken;
            }
        }
        return request({ method, urlPath, body, headers });
    }

    return {
        cookies: cookieJar,
        request,
        refreshCsrfToken,
        login,
        api
    };
}

function resetTables() {
    if (defaultContext?.db?.db) {
        defaultContext.db.db.exec('DELETE FROM scripts; DELETE FROM chats;');
    }
}

test.before(async () => {
    appInstance = createApp();
    await appInstance.ready;
    server = appInstance.server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    defaultContext = accountManager.getAccountContext(accountManager.getDefaultAccountId());
});

test.beforeEach(() => {
    resetTables();
});

test.afterEach(() => {
    aiService.generateJson = originalGenerateJson;
});

test.after(async () => {
    aiService.generateJson = originalGenerateJson;
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    if (appInstance) {
        await appInstance.shutdown();
    }
    await accountManager.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('AI admin chat creates script only for Abdulkadir chat via cookies', async () => {
    const client = createClient();
    const loginRes = await client.login('admin', 'test-password');
    assert.equal(loginRes.status, 200);

    const configRes = await client.api('POST', '/api/ai/config', {
        apiKey: 'local-ai-key',
        provider: 'gemini',
        model: 'gemini-2.5-flash'
    });
    assert.equal(configRes.status, 200);

    const chatId = 'abdulkadir-123@c.us';
    defaultContext.db.chats.upsert.run(chatId, 'Abdulkadir', 0, null, 'Merhaba', Date.now(), 0);

    const responses = [
        {
            thought: 'Need to find Abdulkadir chat id',
            tool_name: 'find_chat',
            tool_params: { query: 'abdulkadir' },
            final_response: null
        },
        {
            thought: 'Create script scoped to Abdulkadir chat',
            tool_name: 'create_script',
            tool_params: {
                name: 'Abdulkadir Test Bot',
                description: 'Test bot for Abdulkadir chat',
                code: 'async function onMessage(msg, reply) { if (msg.isFromMe) return; await reply("ok"); }',
                filter: JSON.stringify({ chatIds: [chatId] })
            },
            final_response: null
        },
        {
            thought: 'Done',
            tool_name: null,
            tool_params: null,
            final_response: 'Abdulkadir sohbeti icin test bot olusturuldu.'
        }
    ];
    let callCount = 0;
    aiService.generateJson = async () => responses[Math.min(callCount++, responses.length - 1)];

    const res = await client.api('POST', '/api/ai/admin-chat', {
        message: 'Abdulkadir sohbeti icin test bot yaz',
        history: []
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);
    assert.match(parsed.response, /Abdulkadir/i);
    assert.equal(callCount >= 3, true);

    const scripts = defaultContext.db.scripts.getAll.all();
    assert.equal(scripts.length, 1);
    const script = scripts[0];
    assert.equal(script.name, 'Abdulkadir Test Bot');
    const filter = JSON.parse(script.trigger_filter);
    assert.deepEqual(filter.chatIds, [chatId]);
});

test('AI admin chat does not create scripts for other chat names', async () => {
    const client = createClient();
    const loginRes = await client.login('admin', 'test-password');
    assert.equal(loginRes.status, 200);

    const configRes = await client.api('POST', '/api/ai/config', { apiKey: 'local-ai-key' });
    assert.equal(configRes.status, 200);

    defaultContext.db.chats.upsert.run('abdulkadir-123@c.us', 'Abdulkadir', 0, null, 'Hello', Date.now(), 0);

    const responses = [
        {
            thought: 'Search for non-existing chat',
            tool_name: 'find_chat',
            tool_params: { query: 'mehmet' },
            final_response: null
        },
        {
            thought: 'Report missing chat',
            tool_name: null,
            tool_params: null,
            final_response: 'No matching chat found, no script created.'
        }
    ];
    let callCount = 0;
    aiService.generateJson = async () => responses[Math.min(callCount++, responses.length - 1)];

    const res = await client.api('POST', '/api/ai/admin-chat', {
        message: 'Mehmet sohbeti icin bot yaz',
        history: []
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);
    assert.match(parsed.response, /no script/i);
    assert.equal(callCount >= 2, true);

    const scripts = defaultContext.db.scripts.getAll.all();
    assert.equal(scripts.length, 0);
});

test('AI admin chat asks clarifying questions before assigning a bot to a chat', async () => {
    const client = createClient();
    const loginRes = await client.login('admin', 'test-password');
    assert.equal(loginRes.status, 200);

    const configRes = await client.api('POST', '/api/ai/config', { apiKey: 'local-ai-key' });
    assert.equal(configRes.status, 200);

    defaultContext.db.chats.upsert.run('abdulkadir-123@c.us', 'Abdulkadir', 0, null, 'Hello', Date.now(), 0);

    let called = 0;
    let lastPrompt = null;
    aiService.generateJson = async (options) => {
        called += 1;
        lastPrompt = options?.prompt || null;
        return {
            thought: 'Ask questions first',
            tool_name: null,
            tool_params: null,
            final_response: 'Tamam. Botun karakteri nasil olsun ve hangi konulara girmesin? Her mesaja mi yoksa sadece belirli komutlara mi cevap versin?'
        };
    };

    const res = await client.api('POST', '/api/ai/admin-chat', {
        message: 'Abdulkadir sohbetine AI ata',
        history: []
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);
    assert.match(parsed.response, /karakter/i);
    assert.equal(called, 1);
    assert.ok(lastPrompt);
    assert.match(String(lastPrompt), /\[AI_ASSIGN_NOTICE\]/);

    const scripts = defaultContext.db.scripts.getAll.all();
    assert.equal(scripts.length, 0);
});

test('AI admin chat blocks tool usage for AI assignment until details provided', async () => {
    const client = createClient();
    const loginRes = await client.login('admin', 'test-password');
    assert.equal(loginRes.status, 200);

    const configRes = await client.api('POST', '/api/ai/config', { apiKey: 'local-ai-key' });
    assert.equal(configRes.status, 200);

    const chatId = 'abdulkadir-123@c.us';
    defaultContext.db.chats.upsert.run(chatId, 'Abdulkadir', 0, null, 'Hello', Date.now(), 0);

    const responses = [
        {
            thought: 'Try to jump straight to tools (should be blocked)',
            tool_name: 'find_chat',
            tool_params: { query: 'abdulkadir' },
            final_response: null
        },
        {
            thought: 'Ask clarifying questions instead',
            tool_name: null,
            tool_params: null,
            final_response: 'Botun karakteri nasil olsun, hangi mesajlara cevap versin ve hangi konulara girmesin?'
        }
    ];

    let callCount = 0;
    aiService.generateJson = async (_options) => responses[Math.min(callCount++, responses.length - 1)];

    const res = await client.api('POST', '/api/ai/admin-chat', {
        message: 'Abdulkadir sohbetine AI ata',
        history: []
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);
    assert.match(parsed.response, /karakter/i);
    assert.ok(callCount >= 2);

    const scripts = defaultContext.db.scripts.getAll.all();
    assert.equal(scripts.length, 0);
});
