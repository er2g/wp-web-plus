const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-panel-lifecycle-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tempDir;
process.env.LOGS_DIR = path.join(tempDir, 'logs');
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.ADMIN_BOOTSTRAP_USERNAME = 'admin';
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'test-password';
process.env.ENABLE_BACKGROUND_JOBS = 'false';
process.env.LOG_LEVEL = 'error';

const { createApp } = require('../appFactory');
const accountManager = require('../services/accountManager');

let appInstance;
let server;
let port;

function requestReady() {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { method: 'GET', hostname: '127.0.0.1', port, path: '/readyz' },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({ status: res.statusCode || 0, body }));
            }
        );
        req.on('error', reject);
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

test('readyz returns 503 after beginShutdown', async () => {
    const before = await requestReady();
    assert.equal(before.status, 200);
    const beforeParsed = JSON.parse(before.body);
    assert.equal(beforeParsed.ok, true);
    assert.equal(beforeParsed.shuttingDown, false);

    appInstance.beginShutdown();

    const after = await requestReady();
    assert.equal(after.status, 503);
    const afterParsed = JSON.parse(after.body);
    assert.equal(afterParsed.ok, false);
    assert.equal(afterParsed.shuttingDown, true);
});

