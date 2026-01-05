/**
 * WhatsApp Web Panel - Auth Routes
 */
const express = require('express');
const config = require('../config');
const accountManager = require('../services/accountManager');
const { passwordMeetsPolicy, verifyPassword } = require('../services/passwords');
const { deriveMasterKey, unwrapDataKey, wrapDataKey, keyringAad, vault } = require('../services/encryption');
const { sendError } = require('../lib/httpResponses');
const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';

// Rate limiting constants
const RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    LOCKOUT_DURATION_MS: 15 * 60 * 1000, // 15 minutes
    CLEANUP_INTERVAL_MS: 60 * 60 * 1000   // 1 hour
};

// Simple in-memory rate limiting for login attempts (fallback)
const loginAttempts = new Map();

// Periodic cleanup of old entries to prevent memory leaks
const loginAttemptCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of loginAttempts.entries()) {
        if (now - data.firstAttempt > RATE_LIMIT.LOCKOUT_DURATION_MS) {
            loginAttempts.delete(ip);
        }
    }
}, RATE_LIMIT.CLEANUP_INTERVAL_MS);
if (typeof loginAttemptCleanupTimer.unref === 'function') {
    loginAttemptCleanupTimer.unref();
}

function getClientIp(req) {
    return req.ip || req.connection.remoteAddress || 'unknown';
}

function memoryCheckRateLimit(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (!attempts) return { allowed: true };

    if (now - attempts.firstAttempt > RATE_LIMIT.LOCKOUT_DURATION_MS) {
        loginAttempts.delete(ip);
        return { allowed: true };
    }

    if (attempts.count >= RATE_LIMIT.MAX_ATTEMPTS) {
        const remainingTime = Math.ceil((RATE_LIMIT.LOCKOUT_DURATION_MS - (now - attempts.firstAttempt)) / 1000);
        return { allowed: false, remainingTime };
    }

    return { allowed: true };
}

function memoryRecordFailedAttempt(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (!attempts || now - attempts.firstAttempt > RATE_LIMIT.LOCKOUT_DURATION_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else {
        attempts.count++;
    }
}

function memoryClearAttempts(ip) {
    loginAttempts.delete(ip);
}

function createAuthRouter({ redisClient, redisPrefix } = {}) {
    const router = express.Router();
    const redisKeyPrefix = `${redisPrefix || config.REDIS_PREFIX || 'wp-panel:'}auth:login_attempts:`;
    const useRedis = redisClient && typeof redisClient.get === 'function' && typeof redisClient.incr === 'function';

    const checkRateLimit = async (ip, req) => {
        if (!useRedis) return memoryCheckRateLimit(ip);

        const key = `${redisKeyPrefix}${ip}`;
        try {
            const rawCount = await redisClient.get(key);
            if (!rawCount) return { allowed: true };

            const count = parseInt(rawCount, 10);
            if (!Number.isFinite(count) || count < RATE_LIMIT.MAX_ATTEMPTS) {
                return { allowed: true };
            }

            const ttlMs = await redisClient.pTTL(key);
            const remainingTime = ttlMs > 0
                ? Math.ceil(ttlMs / 1000)
                : Math.ceil(RATE_LIMIT.LOCKOUT_DURATION_MS / 1000);
            return { allowed: false, remainingTime };
        } catch (error) {
            req?.log?.warn('Redis login rate limit check failed', { error: error.message });
            return memoryCheckRateLimit(ip);
        }
    };

    const recordFailedAttempt = async (ip, req) => {
        if (!useRedis) {
            memoryRecordFailedAttempt(ip);
            return;
        }

        const key = `${redisKeyPrefix}${ip}`;
        try {
            const count = await redisClient.incr(key);
            if (count === 1) {
                await redisClient.pExpire(key, RATE_LIMIT.LOCKOUT_DURATION_MS);
            }
        } catch (error) {
            req?.log?.warn('Redis login rate limit increment failed', { error: error.message });
            memoryRecordFailedAttempt(ip);
        }
    };

    const clearAttempts = async (ip, req) => {
        if (!useRedis) {
            memoryClearAttempts(ip);
            return;
        }

        const key = `${redisKeyPrefix}${ip}`;
        try {
            await redisClient.del(key);
        } catch (error) {
            req?.log?.warn('Redis login rate limit clear failed', { error: error.message });
            memoryClearAttempts(ip);
        }
    };

    router.post('/login', async (req, res, next) => {
        const ip = getClientIp(req);
        try {
            const rateCheck = await checkRateLimit(ip, req);

            if (!rateCheck.allowed) {
                if (rateCheck.remainingTime) {
                    res.setHeader('Retry-After', String(rateCheck.remainingTime));
                }
                return sendError(
                    req,
                    res,
                    429,
                    'Too many login attempts. Try again in ' + rateCheck.remainingTime + ' seconds.'
                );
            }

            const body = req.body || {};
            const username = body.username;
            const password = body.password;

            if (!passwordMeetsPolicy(password, config.PASSWORD_POLICY)) {
                req.log?.warn('Password policy violation on login attempt', { ip });
            }

            const normalizedUsername = (username || '').trim().toLowerCase();
            if (!normalizedUsername || !password) {
                await recordFailedAttempt(ip, req);
                return sendError(req, res, 400, 'Username and password required');
            }

            const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
            const user = db.users.getByUsername.get(normalizedUsername);

            if (user && user.is_active && verifyPassword(password, user.password_salt, user.password_hash)) {
                await clearAttempts(ip, req);
                vault.clearSession(req.sessionID);

                let encryptionSalt = user.encryption_salt;
                if (!encryptionSalt) {
                    encryptionSalt = crypto.randomBytes(16).toString('hex');
                    try {
                        db.users.setEncryptionSalt.run(encryptionSalt, user.id);
                    } catch (error) {
                        req.log?.error('Failed to set encryption salt', { error: error.message });
                        return sendError(req, res, 500, 'Encryption setup error');
                    }
                }

                let kek;
                try {
                    kek = deriveMasterKey(password, encryptionSalt);
                } catch (error) {
                    req.log?.error('Failed to derive master key', { error: error.message });
                    return sendError(req, res, 500, 'Encryption setup error');
                }

                const defaultAccountId = accountManager.getDefaultAccountId();
                const accountId = req.session.accountId || defaultAccountId;

                // Envelope-key mode (DEK wrapped per user) is active when any keyring exists for the account.
                // If not active, fall back to legacy mode where the KEK is also used as the data key.
                const keyringCount = db.userKeyrings?.countByAccount?.get(accountId)?.count || 0;
                const keyring = db.userKeyrings?.getByUserAndAccount?.get(user.id, accountId) || null;

                let dek = null;
                if (keyringCount > 0) {
                    if (keyring?.wrapped_dek) {
                        try {
                            dek = unwrapDataKey(keyring.wrapped_dek, kek, keyringAad({ accountId, userId: user.id }));
                        } catch (error) {
                            req.log?.error('Failed to unwrap account key', { error: error.message });
                            return sendError(req, res, 403, 'Account key invalid');
                        }
                    } else {
                        // Allow first-time provisioning if another session has the account unlocked.
                        const unlockedDek = vault.getAccountKey(accountId);
                        if (!unlockedDek) {
                            return sendError(req, res, 423, 'Vault locked: ask an admin to login first');
                        }
                        try {
                            const wrapped = wrapDataKey(unlockedDek, kek, keyringAad({ accountId, userId: user.id }));
                            db.userKeyrings.upsert.run(user.id, accountId, wrapped);
                            dek = unlockedDek;
                        } catch (error) {
                            req.log?.error('Failed to provision account key', { error: error.message });
                            return sendError(req, res, 500, 'Encryption setup error');
                        }
                    }
                } else {
                    dek = kek;
                }

                req.session.regenerate(err => {
                    if (err) {
                        req.log?.error('Failed to regenerate session after login', { error: err.message });
                        return sendError(req, res, 500, 'Session error');
                    }
                    req.session.authenticated = true;
                    req.session.userId = user.id;
                    req.session.role = user.role || 'agent';
                    try {
                        req.session.accountId = accountId;
                        vault.setSession(req.sessionID, { kek, userId: user.id });
                        vault.setAccountKeyForSession(accountId, dek, req.sessionID);
                    } catch (error) {
                        req.log?.error('Failed to store session key', { error: error.message });
                        return sendError(req, res, 500, 'Encryption setup error');
                    }
                    return res.json({ success: true });
                });
                return;
            }

            await recordFailedAttempt(ip, req);
            return sendError(req, res, 401, 'Invalid credentials');
        } catch (error) {
            return next(error);
        }
    });

    function normalizeInviteCode(value) {
        const raw = (value || '').toString().trim().toUpperCase();
        const compact = raw.replace(/[^A-Z0-9]/g, '');
        if (!compact) return '';
        // Normalize as XXXX-XXXX-XXXX (12 chars) when possible; else keep compact.
        if (compact.length === 12) {
            return compact.match(/.{1,4}/g).join('-');
        }
        return raw;
    }

    router.post('/register', async (req, res, next) => {
        try {
            const body = req.body || {};
            const usernameRaw = body.username;
            const password = body.password;
            const inviteCodeRaw = body.inviteCode || body.invite_code || body.code;

            const normalizedUsername = (usernameRaw || '').trim().toLowerCase();
            const inviteCode = normalizeInviteCode(inviteCodeRaw);

            if (!normalizedUsername || !password || !inviteCode) {
                return sendError(req, res, 400, 'Tüm alanlar gerekli');
            }

            if (!passwordMeetsPolicy(password, config.PASSWORD_POLICY)) {
                return sendError(req, res, 400, 'Password does not meet policy');
            }

            const defaultAccountId = accountManager.getDefaultAccountId();
            const db = accountManager.getAccountContext(defaultAccountId).db;

            const invite = db.invites.getByCode.get(inviteCode);
            if (!invite) {
                return sendError(req, res, 400, 'Geçersiz davet kodu');
            }
            if (invite.is_used) {
                return sendError(req, res, 400, 'Bu davet kodu daha önce kullanılmış');
            }

            if (db.users.getByUsername.get(normalizedUsername)) {
                return sendError(req, res, 409, 'Bu kullanıcı adı zaten alınmış');
            }

            const agentRole = db.roles.getByName.get('agent');
            if (!agentRole) {
                return sendError(req, res, 500, 'Agent role missing');
            }

            const { hashPassword } = require('../services/passwords');
            const { hash, salt } = hashPassword(password);
            const encryptionSalt = crypto.randomBytes(16).toString('hex');

            const result = db.users.create.run(
                normalizedUsername,
                normalizedUsername,
                hash,
                salt,
                encryptionSalt,
                1,
                null
            );
            const userId = result.lastInsertRowid;
            db.userRoles.assign.run(userId, agentRole.id);

            const keyringCount = db.userKeyrings?.countByAccount?.get(defaultAccountId)?.count || 0;
            if (keyringCount > 0) {
                const dek = vault.getAccountKey(defaultAccountId);
                if (!dek) {
                    // Cannot provision the new user without an unlocked account DEK.
                    try { db.users.delete.run(userId); } catch (e) {}
                    return sendError(req, res, 423, 'Vault locked: admin must be online to register');
                }

                const newUserKek = deriveMasterKey(password, encryptionSalt);
                const wrappedDek = wrapDataKey(dek, newUserKek, keyringAad({ accountId: defaultAccountId, userId }));
                db.userKeyrings.upsert.run(userId, defaultAccountId, wrappedDek);
            }

            const marked = db.invites.markUsed.run(userId, inviteCode);
            if (!marked || marked.changes === 0) {
                // Invite got used concurrently; rollback user creation to avoid orphan accounts.
                try {
                    try { db.userKeyrings?.delete?.run(userId, defaultAccountId); } catch (e) {}
                    db.users.delete.run(userId);
                } catch (e) {}
                return sendError(req, res, 409, 'Bu davet kodu daha önce kullanılmış');
            }

            return res.json({ success: true, message: 'Kayıt başarılı! Giriş yapabilirsiniz.' });
        } catch (error) {
            return next(error);
        }
    });

    router.post('/logout', (req, res) => {
        vault.clearSession(req.sessionID);
        req.session.destroy(err => {
            if (err) {
                req.log?.error('Failed to destroy session on logout', { error: err.message });
                return sendError(req, res, 500, 'Session error');
            }
            res.clearCookie('whatsapp.sid', {
                path: '/',
                secure: isProduction,
                sameSite: 'lax'
            });
            return res.json({ success: true });
        });
    });

    router.get('/check', (req, res) => {
        let preferences = null;
        const vaultUnlocked = Boolean(req.session?.authenticated && vault.hasSession(req.sessionID));
        if (req.session && req.session.authenticated && req.session.userId) {
            const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
            const user = db.users.getById.get(req.session.userId);
            if (vaultUnlocked && user && user.preferences) {
                try {
                    preferences = JSON.parse(user.preferences);
                } catch (e) {}
            }
        }

        return res.json({
            authenticated: req.session && req.session.authenticated === true && vaultUnlocked,
            vaultUnlocked,
            userId: req.session?.userId || null,
            role: req.session?.role || null,
            preferences
        });
    });

    return router;
}

module.exports = createAuthRouter;
