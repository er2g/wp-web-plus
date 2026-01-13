const crypto = require('crypto');

const TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 5000;

const store = new Map();

function cleanup(nowMs = Date.now()) {
    for (const [code, entry] of store.entries()) {
        if (!entry || entry.expiresAt <= nowMs) {
            store.delete(code);
        }
    }
}

function createLink({ userId, accountId, redirectTo }) {
    const nowMs = Date.now();
    cleanup(nowMs);
    if (store.size > MAX_ENTRIES) {
        // Drop oldest entries to prevent unbounded growth.
        const items = Array.from(store.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (let i = 0; i < Math.max(1, Math.ceil(items.length * 0.25)); i += 1) {
            store.delete(items[i][0]);
        }
    }

    const code = crypto.randomBytes(24).toString('base64url');
    store.set(code, {
        createdAt: nowMs,
        expiresAt: nowMs + TTL_MS,
        userId: Number(userId) || null,
        accountId: accountId ? String(accountId) : null,
        redirectTo: redirectTo ? String(redirectTo) : '/'
    });
    return { code, expiresInMs: TTL_MS };
}

function consume(code) {
    const nowMs = Date.now();
    cleanup(nowMs);
    const entry = store.get(code);
    if (!entry) return null;
    store.delete(code);
    if (!entry.userId || entry.expiresAt <= nowMs) return null;
    return entry;
}

module.exports = { createLink, consume };

