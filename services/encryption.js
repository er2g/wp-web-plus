/**
 * Zero-Knowledge Encryption Service (AES-256-GCM + PBKDF2)
 *
 * - Encrypts sensitive fields at rest with random IVs (non-deterministic).
 * - Derives per-session master key from the user's raw password + stored salt.
 * - Keeps keys only in memory via an in-process vault (lost on restart).
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

class CryptoLockedError extends Error {
    constructor(message = 'Vault locked') {
        super(message);
        this.name = 'CryptoLockedError';
        this.code = 'VAULT_LOCKED';
        this.status = 423;
    }
}

const CIPHERTEXT_PREFIX = 'enc:v1:';
const DEFAULT_AAD_NAMESPACE = 'wp-web-plus';

const KDF_DEFAULTS = Object.freeze({
    iterations: 310000,
    digest: 'sha256',
    keylen: 32
});

function bufferFromHex(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
        throw new Error('Invalid hex salt');
    }
    return Buffer.from(hex, 'hex');
}

function deriveMasterKey(password, saltHex, options = {}) {
    const { iterations, digest, keylen } = { ...KDF_DEFAULTS, ...options };
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('Password required');
    }
    const salt = bufferFromHex(saltHex);
    return crypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
}

function isEncryptedValue(value) {
    return typeof value === 'string' && value.startsWith(CIPHERTEXT_PREFIX);
}

function packV1(iv, tag, ciphertext) {
    return `${CIPHERTEXT_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

function unpackV1(value) {
    if (!isEncryptedValue(value)) return null;
    const raw = value.slice(CIPHERTEXT_PREFIX.length);
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 12 + 16) {
        throw new Error('Invalid ciphertext');
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    return { iv, tag, ciphertext };
}

function encryptString(plaintext, key, aad = DEFAULT_AAD_NAMESPACE) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    if (isEncryptedValue(plaintext)) return plaintext;
    const normalized = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    if (aad) {
        cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    }
    const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return packV1(iv, tag, ciphertext);
}

function decryptString(value, key, aad = DEFAULT_AAD_NAMESPACE) {
    if (value === null || value === undefined) return value;
    if (!isEncryptedValue(value)) return value;
    const unpacked = unpackV1(value);
    if (!unpacked) return value;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unpacked.iv);
    if (aad) {
        decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    }
    decipher.setAuthTag(unpacked.tag);
    const plaintext = Buffer.concat([decipher.update(unpacked.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
}

const cryptoContext = new AsyncLocalStorage();

function runWithCryptoContext(context, fn) {
    return cryptoContext.run(context, fn);
}

function getCryptoContext() {
    return cryptoContext.getStore() || null;
}

class InMemoryKeyVault {
    constructor(options = {}) {
        this.sessionTtlMs = Number(options.sessionTtlMs) || 24 * 60 * 60 * 1000;
        this.sessionKeys = new Map(); // sessionId -> { key: Buffer, userId, createdAt, lastSeenAt }
        this.accountKeys = new Map(); // accountId -> Buffer
        this.accountSessions = new Map(); // accountId -> Set(sessionId)

        const pruneIntervalMs = Number(options.pruneIntervalMs) || 10 * 60 * 1000;
        const timer = setInterval(() => this.prune(), pruneIntervalMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    setSessionKey(sessionId, { key, userId } = {}) {
        if (!sessionId || typeof sessionId !== 'string') {
            throw new Error('sessionId required');
        }
        if (!Buffer.isBuffer(key) || key.length !== 32) {
            throw new Error('Invalid master key');
        }
        const now = Date.now();
        this.sessionKeys.set(sessionId, {
            key,
            userId: userId || null,
            createdAt: now,
            lastSeenAt: now
        });
    }

    getSessionKey(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') return null;
        const entry = this.sessionKeys.get(sessionId);
        if (!entry) return null;
        entry.lastSeenAt = Date.now();
        return entry.key;
    }

    hasSessionKey(sessionId) {
        return Boolean(this.getSessionKey(sessionId));
    }

    attachSessionToAccount(sessionId, accountId) {
        if (!accountId || typeof accountId !== 'string') return false;
        const key = this.getSessionKey(sessionId);
        if (!key) return false;

        const current = this.accountKeys.get(accountId);
        if (current) {
            if (current.length === key.length && crypto.timingSafeEqual(current, key)) {
                // ok, same key
            } else {
                // Allow key rotation when another user unlocks the same account.
                // This keeps background jobs functional for the most recently unlocked key.
                this.accountKeys.set(accountId, key);
                this.accountSessions.set(accountId, new Set([sessionId]));
                return true;
            }
        } else {
            this.accountKeys.set(accountId, key);
        }

        const set = this.accountSessions.get(accountId) || new Set();
        set.add(sessionId);
        this.accountSessions.set(accountId, set);
        return true;
    }

    getAccountKey(accountId) {
        if (!accountId || typeof accountId !== 'string') return null;
        return this.accountKeys.get(accountId) || null;
    }

    isAccountUnlocked(accountId) {
        return Boolean(this.getAccountKey(accountId));
    }

    clearSession(sessionId) {
        if (!sessionId || typeof sessionId !== 'string') return;
        this.sessionKeys.delete(sessionId);

        for (const [accountId, sessions] of this.accountSessions.entries()) {
            if (sessions.delete(sessionId)) {
                if (sessions.size === 0) {
                    this.accountSessions.delete(accountId);
                    this.accountKeys.delete(accountId);
                } else {
                    this.accountSessions.set(accountId, sessions);
                }
            }
        }
    }

    prune() {
        const now = Date.now();
        for (const [sessionId, entry] of this.sessionKeys.entries()) {
            if (now - entry.lastSeenAt > this.sessionTtlMs) {
                this.clearSession(sessionId);
            }
        }
    }
}

const vault = new InMemoryKeyVault();

function aadForField({ accountId, table, column } = {}) {
    const safeAccount = typeof accountId === 'string' && accountId ? accountId : 'unknown';
    const safeTable = typeof table === 'string' && table ? table : 'unknown_table';
    const safeColumn = typeof column === 'string' && column ? column : 'unknown_column';
    return `${DEFAULT_AAD_NAMESPACE}|${safeAccount}|${safeTable}|${safeColumn}`;
}

function getActiveKey({ accountId, sessionId } = {}) {
    const ctx = getCryptoContext();
    if (ctx?.key && Buffer.isBuffer(ctx.key)) {
        return ctx.key;
    }

    if (sessionId) {
        const fromSession = vault.getSessionKey(sessionId);
        if (fromSession) return fromSession;
    }

    if (accountId) {
        const fromAccount = vault.getAccountKey(accountId);
        if (fromAccount) return fromAccount;
    }

    return null;
}

module.exports = {
    CryptoLockedError,
    KDF_DEFAULTS,
    deriveMasterKey,
    encryptString,
    decryptString,
    isEncryptedValue,
    aadForField,
    runWithCryptoContext,
    getCryptoContext,
    getActiveKey,
    vault
};
