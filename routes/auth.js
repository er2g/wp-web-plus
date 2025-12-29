/**
 * WhatsApp Web Panel - Auth Routes
 */
const express = require('express');
const router = express.Router();
const config = require('../config');
const accountManager = require('../services/accountManager');
const { passwordMeetsPolicy, verifyPassword } = require('../services/passwords');

const isProduction = process.env.NODE_ENV === 'production';

// Rate limiting constants
const RATE_LIMIT = {
    MAX_ATTEMPTS: 5,
    LOCKOUT_DURATION_MS: 15 * 60 * 1000, // 15 minutes
    CLEANUP_INTERVAL_MS: 60 * 60 * 1000   // 1 hour
};

// Simple in-memory rate limiting for login attempts
const loginAttempts = new Map();

// Periodic cleanup of old entries to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of loginAttempts.entries()) {
        if (now - data.firstAttempt > RATE_LIMIT.LOCKOUT_DURATION_MS) {
            loginAttempts.delete(ip);
        }
    }
}, RATE_LIMIT.CLEANUP_INTERVAL_MS);

function getClientIp(req) {
    return req.ip || req.connection.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (!attempts) return { allowed: true };

    // Clean up old entries
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

function recordFailedAttempt(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (!attempts || now - attempts.firstAttempt > RATE_LIMIT.LOCKOUT_DURATION_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else {
        attempts.count++;
    }
}

function clearAttempts(ip) {
    loginAttempts.delete(ip);
}

// Login
router.post('/login', (req, res) => {
    const ip = getClientIp(req);
    const rateCheck = checkRateLimit(ip);

    if (!rateCheck.allowed) {
        return res.status(429).json({
            error: 'Too many login attempts. Try again in ' + rateCheck.remainingTime + ' seconds.'
        });
    }

    const { username, password } = req.body;

    if (!passwordMeetsPolicy(password, config.PASSWORD_POLICY)) {
        console.warn(`Password policy violation on login attempt from ${ip}.`);
    }

    const normalizedUsername = (username || '').trim().toLowerCase();
    if (!normalizedUsername || !password) {
        recordFailedAttempt(ip);
        return res.status(400).json({ error: 'Username and password required' });
    }

    const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
    const user = db.users.getByUsername.get(normalizedUsername);

    if (user && user.is_active && verifyPassword(password, user.password_salt, user.password_hash)) {
        clearAttempts(ip);
        req.session.regenerate(err => {
            if (err) {
                console.error('Failed to regenerate session after login:', err);
                return res.status(500).json({ error: 'Session error' });
            }
            req.session.authenticated = true;
            req.session.userId = user.id;
            req.session.role = user.role || 'agent';
            res.json({ success: true });
        });
    } else {
        recordFailedAttempt(ip);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Failed to destroy session on logout:', err);
            return res.status(500).json({ error: 'Session error' });
        }
        res.clearCookie('whatsapp.sid', {
            path: '/',
            secure: isProduction,
            sameSite: 'lax'
        });
        res.json({ success: true });
    });
});

// Check auth status
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

    res.json({
        authenticated: req.session && req.session.authenticated === true,
        userId: req.session?.userId || null,
        role: req.session?.role || null,
        preferences
    });
});

module.exports = router;
