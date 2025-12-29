const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-panel-test-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tempDir;
process.env.LOGS_DIR = path.join(tempDir, 'logs');
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.ADMIN_BOOTSTRAP_USERNAME = 'admin';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'test-password';
process.env.ENABLE_BACKGROUND_JOBS = 'false';
process.env.LOG_LEVEL = 'error';
process.env.METRICS_ENABLED = 'true';
process.env.METRICS_TOKEN = 'test-metrics-token';

const { createApp } = require('../appFactory');
const accountManager = require('../services/accountManager');

let appInstance;
let server;
let port;

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

    function request({ method, urlPath, body, headers }) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request(
                {
                    method,
                    hostname: '127.0.0.1',
                    port,
                    path: urlPath,
                    headers: {
                        ...(headers || {}),
                        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
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

test.before(async () => {
    appInstance = createApp();
    await appInstance.ready;
    server = appInstance.server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

test.after(async () => {
    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    if (appInstance) {
        await appInstance.shutdown();
    }
    await accountManager.shutdown();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('GET /auth/check sets CSRF cookie', async () => {
    const client = createClient();
    const res = await client.request({ method: 'GET', urlPath: '/auth/check' });
    assert.equal(res.status, 200);
    assert.ok(client.cookies.has('XSRF-TOKEN'));
});

test('GET /healthz returns ok', async () => {
    const client = createClient();
    const res = await client.request({ method: 'GET', urlPath: '/healthz' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
});

test('GET /readyz returns ok', async () => {
    const client = createClient();
    const res = await client.request({ method: 'GET', urlPath: '/readyz' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.dependencies);
    assert.ok(parsed.dependencies.redis);
});

test('GET /openapi.json returns OpenAPI spec', async () => {
    const client = createClient();
    const res = await client.request({ method: 'GET', urlPath: '/openapi.json' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.openapi, '3.0.3');
    assert.ok(parsed.info);
    assert.ok(parsed.paths);
    assert.ok(parsed.paths['/healthz']);
    assert.ok(parsed.paths['/auth/login']);
    assert.ok(parsed.paths['/api/webhooks']);
    assert.ok(parsed.paths['/api/templates']);
    assert.ok(parsed.paths['/api/drive/status']);
});

test('GET /docs requires auth', async () => {
    const client = createClient();
    const res = await client.request({ method: 'GET', urlPath: '/docs' });
    assert.equal(res.status, 401);
});

test('GET /docs serves swagger ui for admin', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/docs/' });
    assert.equal(res.status, 200);
    assert.ok(String(res.headers['content-type'] || '').includes('text/html'));
    assert.match(res.body, /Swagger UI/i);
});

test('GET /metrics returns prometheus text when enabled', async () => {
    const client = createClient();
    await client.request({ method: 'GET', urlPath: '/auth/check' });

    const res = await client.request({
        method: 'GET',
        urlPath: '/metrics',
        headers: { Authorization: 'Bearer test-metrics-token' }
    });
    assert.equal(res.status, 200);
    assert.ok(String(res.headers['content-type'] || '').includes('text/plain'));
    assert.match(res.body, /# HELP wp_panel_http_requests_total/);
    assert.match(res.body, /# HELP wp_panel_message_pipeline_messages_total/);
    assert.match(res.body, /# HELP wp_panel_message_pipeline_task_total/);
    assert.match(res.body, /wp_panel_process_cpu_user_seconds_total/);
});

test('GET /metrics returns 401 when token is missing or wrong', async () => {
    const client = createClient();
    await client.request({ method: 'GET', urlPath: '/auth/check' });

    const missing = await client.request({ method: 'GET', urlPath: '/metrics' });
    assert.equal(missing.status, 401);

    const wrong = await client.request({
        method: 'GET',
        urlPath: '/metrics',
        headers: { Authorization: 'Bearer wrong-token' }
    });
    assert.equal(wrong.status, 401);
});

test('POST /auth/login rejects without CSRF token', async () => {
    const client = createClient();
    await client.request({ method: 'GET', urlPath: '/auth/check' });

    const res = await client.request({
        method: 'POST',
        urlPath: '/auth/login',
        body: { username: 'admin', password: 'test-password' }
    });

    assert.equal(res.status, 403);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Invalid CSRF token');
});

test('POST /auth/login succeeds with CSRF token', async () => {
    const client = createClient();
    const res = await client.login('admin', 'test-password');

    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);

    const check = await client.request({ method: 'GET', urlPath: '/auth/check' });
    const checkParsed = JSON.parse(check.body);
    assert.equal(checkParsed.authenticated, true);
    assert.equal(checkParsed.role, 'admin');
});

test('POST /auth/login succeeds after a failed attempt', async () => {
    const client = createClient();

    const bad = await client.login('admin', 'wrong-password');
    assert.equal(bad.status, 401);

    const good = await client.login('admin', 'test-password');
    assert.equal(good.status, 200);
    const parsed = JSON.parse(good.body);
    assert.equal(parsed.success, true);
});

test('GET /api/status requires auth', async () => {
    const client = createClient();
    const res = await client.request({ method: 'GET', urlPath: '/api/status' });
    assert.equal(res.status, 401);
});

test('GET /api/status returns whatsapp status + stats', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/api/status' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.whatsapp);
    assert.ok(parsed.stats);
    assert.equal(typeof parsed.whatsapp.status, 'string');
});

test('GET /api/accounts returns accounts for admin', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/api/accounts' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.accounts));
    assert.ok(parsed.accounts.length >= 1);
    assert.ok(parsed.currentAccountId);
});

test('POST /api/accounts creates a new account (admin)', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const createRes = await client.api('POST', '/api/accounts', { name: 'Test Account' });
    assert.equal(createRes.status, 200);
    const created = JSON.parse(createRes.body);
    assert.equal(created.success, true);
    assert.ok(created.account);
    assert.ok(created.account.id);

    const listRes = await client.request({ method: 'GET', urlPath: '/api/accounts' });
    const list = JSON.parse(listRes.body);
    assert.ok(list.accounts.some(acc => acc.id === created.account.id));
});

test('POST /api/accounts/select switches active account', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const createRes = await client.api('POST', '/api/accounts', { name: 'Selectable Account' });
    const created = JSON.parse(createRes.body);
    const accountId = created.account.id;

    const selectRes = await client.api('POST', '/api/accounts/select', { accountId });
    assert.equal(selectRes.status, 200);
    const selectParsed = JSON.parse(selectRes.body);
    assert.equal(selectParsed.success, true);
    assert.equal(selectParsed.accountId, accountId);

    const listRes = await client.request({ method: 'GET', urlPath: '/api/accounts' });
    const listParsed = JSON.parse(listRes.body);
    assert.equal(listParsed.currentAccountId, accountId);
});

test('POST /api/webhooks rejects localhost urls', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.api('POST', '/api/webhooks', {
        name: 'Test Webhook',
        url: 'http://localhost/hook',
        events: 'message',
        is_active: true
    });

    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Invalid URL. Must be http or https.');
});

test('POST /api/webhooks creates webhook with safe url', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const create = await client.api('POST', '/api/webhooks', {
        name: 'Test Webhook',
        url: 'https://example.com/hook',
        events: 'message',
        is_active: true
    });

    assert.equal(create.status, 200);
    const created = JSON.parse(create.body);
    assert.equal(created.success, true);
    assert.ok(created.id);

    const list = await client.request({ method: 'GET', urlPath: '/api/webhooks' });
    assert.equal(list.status, 200);
    const webhooks = JSON.parse(list.body);
    assert.ok(Array.isArray(webhooks));
    assert.ok(webhooks.some(w => w.id === created.id));
});

test('templates CRUD works (admin)', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const create = await client.api('POST', '/api/templates', {
        name: 'Test Template',
        content: 'Hello {name}',
        variables: 'name',
        category: 'test'
    });
    assert.equal(create.status, 200);
    const created = JSON.parse(create.body);
    assert.equal(created.success, true);
    const templateId = created.id;
    assert.ok(templateId);

    const getOne = await client.request({ method: 'GET', urlPath: `/api/templates/${templateId}` });
    assert.equal(getOne.status, 200);
    const template = JSON.parse(getOne.body);
    assert.equal(template.id, templateId);
    assert.equal(template.name, 'Test Template');

    const update = await client.api('PUT', `/api/templates/${templateId}`, {
        name: 'Test Template Updated',
        content: 'Hi {name}',
        variables: ['name'],
        category: 'test'
    });
    assert.equal(update.status, 200);

    const getUpdated = await client.request({ method: 'GET', urlPath: `/api/templates/${templateId}` });
    const updatedTemplate = JSON.parse(getUpdated.body);
    assert.equal(updatedTemplate.name, 'Test Template Updated');

    const del = await client.api('DELETE', `/api/templates/${templateId}`);
    assert.equal(del.status, 200);
    const delParsed = JSON.parse(del.body);
    assert.equal(delParsed.success, true);
});

test('scheduled messages CRUD works (no WhatsApp required)', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const create = await client.api('POST', '/api/scheduled', {
        chat_id: '905555555555@c.us',
        chat_name: 'Test Chat',
        message: 'Hello later',
        scheduled_at: scheduledAt
    });
    assert.equal(create.status, 200);
    const created = JSON.parse(create.body);
    assert.equal(created.success, true);
    const scheduledId = created.id;
    assert.ok(scheduledId);

    const list = await client.request({ method: 'GET', urlPath: '/api/scheduled' });
    assert.equal(list.status, 200);
    const scheduled = JSON.parse(list.body);
    assert.ok(Array.isArray(scheduled));
    assert.ok(scheduled.some(item => item.id === scheduledId));

    const del = await client.api('DELETE', `/api/scheduled/${scheduledId}`);
    assert.equal(del.status, 200);
    const delParsed = JSON.parse(del.body);
    assert.equal(delParsed.success, true);
});

test('script sandbox test endpoint works', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.api('POST', '/api/scripts/test', {
        code: "log('hello from test')"
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);
});

test('GET /api/logs returns array for admin', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/api/logs' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed));
});

test('GET /api/stats returns aggregates', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/api/stats' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.messages);
    assert.ok(parsed.webhooks);
    assert.ok(parsed.scripts);
});

test('GET /api/reports/overview returns empty overview structure', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/api/reports/overview' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.range);
    assert.ok(parsed.overview);
    assert.ok(Array.isArray(parsed.topChats));
});

test('GET /api/reports/trends rejects invalid range', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.request({ method: 'GET', urlPath: '/api/reports/trends?start=10&end=1' });
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'Invalid date range');
});

test('GET /api/roles and /api/users work for admin', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const rolesRes = await client.request({ method: 'GET', urlPath: '/api/roles' });
    assert.equal(rolesRes.status, 200);
    const roles = JSON.parse(rolesRes.body);
    assert.ok(Array.isArray(roles));
    assert.ok(roles.some(r => r.name === 'admin'));

    const usersRes = await client.request({ method: 'GET', urlPath: '/api/users' });
    assert.equal(usersRes.status, 200);
    const users = JSON.parse(usersRes.body);
    assert.ok(Array.isArray(users));
    assert.ok(users.some(u => u.username === 'admin'));
});

test('PUT /api/users/me/preferences stores preferences', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const res = await client.api('PUT', '/api/users/me/preferences', { uiTheme: 'dark' });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.success, true);
});

test('GET /api/chats and /api/messages return expected shapes', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const chatsRes = await client.request({ method: 'GET', urlPath: '/api/chats' });
    assert.equal(chatsRes.status, 200);
    const chats = JSON.parse(chatsRes.body);
    assert.ok(Array.isArray(chats));

    const messagesRes = await client.request({ method: 'GET', urlPath: '/api/messages?limit=10&offset=0' });
    assert.equal(messagesRes.status, 200);
    const parsed = JSON.parse(messagesRes.body);
    assert.ok(Array.isArray(parsed.messages));
    assert.ok(parsed.tagsByChat && typeof parsed.tagsByChat === 'object');
    assert.ok(parsed.notesByChat && typeof parsed.notesByChat === 'object');
});

test('tags, chat tags and notes endpoints work', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const unique = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const tagName = `tag-${unique}`;
    const chatId = '905555555555@c.us';
    const chatPathId = encodeURIComponent(chatId);

    const createTagRes = await client.api('POST', '/api/tags', { name: tagName, color: '#ff0000' });
    assert.equal(createTagRes.status, 200);
    const createdTag = JSON.parse(createTagRes.body);
    assert.equal(createdTag.success, true);
    const tagId = createdTag.id;
    assert.ok(tagId);

    const addTagRes = await client.api('POST', `/api/chats/${chatPathId}/tags`, { tag_id: tagId });
    assert.equal(addTagRes.status, 200);
    const addParsed = JSON.parse(addTagRes.body);
    assert.equal(addParsed.success, true);

    const chatTagsRes = await client.request({ method: 'GET', urlPath: `/api/chats/${chatPathId}/tags` });
    assert.equal(chatTagsRes.status, 200);
    const chatTags = JSON.parse(chatTagsRes.body);
    assert.ok(Array.isArray(chatTags));
    assert.ok(chatTags.some(tag => String(tag.id) === String(tagId)));

    const contactTagsRes = await client.request({ method: 'GET', urlPath: `/api/contacts/${chatPathId}/tags` });
    assert.equal(contactTagsRes.status, 200);
    const contactTags = JSON.parse(contactTagsRes.body);
    assert.ok(Array.isArray(contactTags));
    assert.ok(contactTags.some(tag => String(tag.id) === String(tagId)));

    const noteContent = `note-${unique}`;
    const createNoteRes = await client.api('POST', `/api/chats/${chatPathId}/notes`, { content: noteContent });
    assert.equal(createNoteRes.status, 200);
    const createNoteParsed = JSON.parse(createNoteRes.body);
    assert.equal(createNoteParsed.success, true);

    const notesRes = await client.request({ method: 'GET', urlPath: `/api/chats/${chatPathId}/notes` });
    assert.equal(notesRes.status, 200);
    const notes = JSON.parse(notesRes.body);
    assert.ok(Array.isArray(notes));
    assert.ok(notes.some(note => note.content === noteContent));

    const noteId = notes.find(note => note.content === noteContent)?.id;
    assert.ok(noteId);

    const updatedContent = `${noteContent}-updated`;
    const updateNoteRes = await client.api('PUT', `/api/chats/${chatPathId}/notes/${noteId}`, { content: updatedContent });
    assert.equal(updateNoteRes.status, 200);
    const updateNoteParsed = JSON.parse(updateNoteRes.body);
    assert.equal(updateNoteParsed.success, true);

    const deleteNoteRes = await client.api('DELETE', `/api/chats/${chatPathId}/notes/${noteId}`);
    assert.equal(deleteNoteRes.status, 200);
    const deleteNoteParsed = JSON.parse(deleteNoteRes.body);
    assert.equal(deleteNoteParsed.success, true);

    const removeTagRes = await client.api('DELETE', `/api/chats/${chatPathId}/tags/${tagId}`);
    assert.equal(removeTagRes.status, 200);
    const removeTagParsed = JSON.parse(removeTagRes.body);
    assert.equal(removeTagParsed.success, true);

    const deleteTagRes = await client.api('DELETE', `/api/tags/${tagId}`);
    assert.equal(deleteTagRes.status, 200);
    const deleteTagParsed = JSON.parse(deleteTagRes.body);
    assert.equal(deleteTagParsed.success, true);
});

test('POST /api/send validates input without WhatsApp', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const missingRes = await client.api('POST', '/api/send', { message: 'hi' });
    assert.equal(missingRes.status, 400);
    const missingParsed = JSON.parse(missingRes.body);
    assert.equal(missingParsed.error, 'chatId and message or media required');

    const invalidRes = await client.api('POST', '/api/send', { chatId: 'invalid space@c.us', message: 'hi' });
    assert.equal(invalidRes.status, 400);
    const invalidParsed = JSON.parse(invalidRes.body);
    assert.equal(invalidParsed.error, 'Invalid chatId format');
});

test('auto replies CRUD works (admin)', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const unique = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const createRes = await client.api('POST', '/api/auto-replies', {
        trigger_word: `hello-${unique}`,
        response: 'hi',
        match_type: 'contains',
        is_active: true
    });
    assert.equal(createRes.status, 200);
    const created = JSON.parse(createRes.body);
    assert.equal(created.success, true);
    const replyId = created.id;
    assert.ok(replyId);

    const listRes = await client.request({ method: 'GET', urlPath: '/api/auto-replies' });
    assert.equal(listRes.status, 200);
    const list = JSON.parse(listRes.body);
    assert.ok(Array.isArray(list));
    assert.ok(list.some(r => String(r.id) === String(replyId)));

    const toggleRes = await client.api('POST', `/api/auto-replies/${replyId}/toggle`);
    assert.equal(toggleRes.status, 200);
    const toggled = JSON.parse(toggleRes.body);
    assert.equal(toggled.success, true);
    assert.equal(typeof toggled.is_active, 'boolean');

    const deleteRes = await client.api('DELETE', `/api/auto-replies/${replyId}`);
    assert.equal(deleteRes.status, 200);
    const deleted = JSON.parse(deleteRes.body);
    assert.equal(deleted.success, true);
});

test('drive and media endpoints respond safely', async () => {
    const client = createClient();
    await client.login('admin', 'test-password');

    const driveStatusRes = await client.request({ method: 'GET', urlPath: '/api/drive/status' });
    assert.equal(driveStatusRes.status, 200);
    const status = JSON.parse(driveStatusRes.body);
    assert.equal(typeof status.configured, 'boolean');
    assert.equal(typeof status.authorized, 'boolean');

    const migrateRes = await client.api('POST', '/api/drive/migrate');
    assert.equal(migrateRes.status, 200);
    const migrate = JSON.parse(migrateRes.body);
    assert.equal(migrate.success, false);
    assert.ok(typeof migrate.error === 'string');

    const invalidMediaRes = await client.request({ method: 'GET', urlPath: '/api/media/..' });
    assert.equal(invalidMediaRes.status, 400);
    const invalidMedia = JSON.parse(invalidMediaRes.body);
    assert.equal(invalidMedia.error, 'Invalid filename');

    const missingMediaRes = await client.request({ method: 'GET', urlPath: '/api/media/does-not-exist.txt' });
    assert.equal(missingMediaRes.status, 404);
    const missingMedia = JSON.parse(missingMediaRes.body);
    assert.equal(missingMedia.error, 'File not found');
});
