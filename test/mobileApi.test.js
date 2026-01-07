const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-panel-test-mobile-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tempDir;
process.env.LOGS_DIR = path.join(tempDir, 'logs');
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.ADMIN_BOOTSTRAP_USERNAME = 'admin';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'test-password';
process.env.ENABLE_BACKGROUND_JOBS = 'false';
process.env.LOG_LEVEL = 'error';
process.env.METRICS_ENABLED = 'false';
process.env.PUSH_NOTIFICATIONS_ENABLED = 'false';

const { createApp } = require('../appFactory');
const accountManager = require('../services/accountManager');

let appInstance;
let server;
let port;

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
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
                }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
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

test('mobile login returns tokens and can call /api with Bearer auth', async () => {
    const login = await request({
        method: 'POST',
        urlPath: '/api/mobile/login',
        body: { username: 'admin', password: 'test-password' }
    });
    assert.equal(login.status, 200);
    const loginJson = JSON.parse(login.body);
    assert.equal(loginJson.success, true);
    assert.equal(typeof loginJson.accessToken, 'string');
    assert.equal(typeof loginJson.refreshToken, 'string');

    const status = await request({
        method: 'GET',
        urlPath: '/api/status',
        headers: { Authorization: `Bearer ${loginJson.accessToken}` }
    });
    assert.equal(status.status, 200);
    const statusJson = JSON.parse(status.body);
    assert.ok(statusJson.whatsapp);
    assert.ok(statusJson.stats);

    const createTag = await request({
        method: 'POST',
        urlPath: '/api/tags',
        headers: { Authorization: `Bearer ${loginJson.accessToken}` },
        body: { name: 'mobile-test-tag' }
    });
    assert.equal(createTag.status, 200);
    const createTagJson = JSON.parse(createTag.body);
    assert.equal(createTagJson.success, true);
});

test('mobile refresh rotates refresh tokens', async () => {
    const login = await request({
        method: 'POST',
        urlPath: '/api/mobile/login',
        body: { username: 'admin', password: 'test-password' }
    });
    const loginJson = JSON.parse(login.body);

    const refresh = await request({
        method: 'POST',
        urlPath: '/api/mobile/refresh',
        body: { refreshToken: loginJson.refreshToken }
    });
    assert.equal(refresh.status, 200);
    const refreshJson = JSON.parse(refresh.body);
    assert.equal(refreshJson.success, true);
    assert.equal(typeof refreshJson.accessToken, 'string');
    assert.equal(typeof refreshJson.refreshToken, 'string');
    assert.notEqual(refreshJson.refreshToken, loginJson.refreshToken);
});

