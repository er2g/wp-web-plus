const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('config fails fast on invalid PORT', () => {
    const repoRoot = path.join(__dirname, '..');
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: 'not-a-number'
        },
        encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    const stderr = String(result.stderr || '');
    assert.ok(stderr.includes('Invalid environment variables'));
    assert.ok(stderr.includes('PORT'));
});

