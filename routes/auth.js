/**
 * WhatsApp Web Panel - Auth Routes
 */
const express = require('express');
const router = express.Router();
const config = require('../config');

// Simple in-memory rate limiting for login attempts
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes

function getClientIp(req) {
    return req.ip || req.connection.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (!attempts) return { allowed: true };

    // Clean up old entries
    if (now - attempts.firstAttempt > LOCKOUT_TIME) {
        loginAttempts.delete(ip);
        return { allowed: true };
    }

    if (attempts.count >= MAX_ATTEMPTS) {
        const remainingTime = Math.ceil((LOCKOUT_TIME - (now - attempts.firstAttempt)) / 1000);
        return { allowed: false, remainingTime };
    }

    return { allowed: true };
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    const attempts = loginAttempts.get(ip);

    if (!attempts || now - attempts.firstAttempt > LOCKOUT_TIME) {
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

    const { password } = req.body;

    if (password === config.SITE_PASSWORD) {
        clearAttempts(ip);
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        recordFailedAttempt(ip);
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Check auth status
router.get('/check', (req, res) => {
    res.json({ authenticated: req.session && req.session.authenticated === true });
});

module.exports = router;
