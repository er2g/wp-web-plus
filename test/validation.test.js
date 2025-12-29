const test = require('node:test');
const assert = require('node:assert/strict');

const { isSafeExternalUrl } = require('../lib/urlSafety');
const { validateChatId, validateUrl, parseDateRange, normalizeTemplateVariables } = require('../lib/apiValidation');

test('isSafeExternalUrl blocks localhost and private IP ranges', () => {
    assert.equal(isSafeExternalUrl('http://localhost'), false);
    assert.equal(isSafeExternalUrl('http://127.0.0.1'), false);
    assert.equal(isSafeExternalUrl('http://10.0.0.1'), false);
    assert.equal(isSafeExternalUrl('http://192.168.1.1'), false);
    assert.equal(isSafeExternalUrl('http://172.16.0.1'), false);
    assert.equal(isSafeExternalUrl('http://169.254.1.2'), false);
    assert.equal(isSafeExternalUrl('http://169.254.169.254'), false);
});

test('isSafeExternalUrl blocks internal domains', () => {
    assert.equal(isSafeExternalUrl('https://example.internal'), false);
    assert.equal(isSafeExternalUrl('https://example.local'), false);
});

test('isSafeExternalUrl allows public http/https urls', () => {
    assert.equal(isSafeExternalUrl('https://example.com'), true);
    assert.equal(isSafeExternalUrl('http://example.com/path'), true);
});

test('validateChatId accepts typical WhatsApp ids', () => {
    assert.equal(validateChatId('905555555555@c.us'), true);
    assert.equal(validateChatId('12345-67890@g.us'), true);
    assert.equal(validateChatId(''), false);
    assert.equal(validateChatId('invalid space@c.us'), false);
});

test('validateUrl uses SSRF-safe rules', () => {
    assert.equal(validateUrl('https://example.com'), true);
    assert.equal(validateUrl('http://localhost'), false);
});

test('parseDateRange returns sane defaults and rejects invalid ranges', () => {
    const now = Date.now();
    const range = parseDateRange({});
    assert.ok(range);
    assert.ok(range.end <= now + 1000);
    assert.ok(range.start < range.end);

    assert.equal(parseDateRange({ start: '10', end: '1' }), null);
    assert.equal(parseDateRange({ start: 'not-a-number' }), null);
});

test('normalizeTemplateVariables handles arrays and strings', () => {
    assert.deepEqual(normalizeTemplateVariables([' a ', '', 'b']), ['a', 'b']);
    assert.deepEqual(normalizeTemplateVariables(' a, b , ,c '), ['a', 'b', 'c']);
});

