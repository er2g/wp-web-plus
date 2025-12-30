/**
 * WhatsApp Web Panel - Auth Routes
 */
const express = require('express');
const config = require('../config');
const accountManager = require('../services/accountManager');
const { passwordMeetsPolicy, verifyPassword } = require('../services/passwords');
const { sendError } = require('../lib/httpResponses');

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
                req.session.regenerate(err => {
                    if (err) {
                        req.log?.error('Failed to regenerate session after login', { error: err.message });
                        return sendError(req, res, 500, 'Session error');
                    }
                    req.session.authenticated = true;
                    req.session.userId = user.id;
                    req.session.role = user.role || 'agent';
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

    router.post('/logout', (req, res) => {
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
        if (req.session && req.session.authenticated && req.session.userId) {
            const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
            const user = db.users.getById.get(req.session.userId);
            if (user && user.preferences) {
                try {
                    preferences = JSON.parse(user.preferences);
                } catch (e) {}
            }
        }

        return res.json({
            authenticated: req.session && req.session.authenticated === true,
            userId: req.session?.userId || null,
            role: req.session?.role || null,
            preferences
        });
    });

    return router;
}

module.exports = createAuthRouter;
