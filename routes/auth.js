/**
 * WhatsApp Web Panel - Auth Routes
 */
const express = require('express');
const router = express.Router();
const config = require('../config');

// Login
router.post('/login', (req, res) => {
    const { password } = req.body;

    if (password === config.SITE_PASSWORD) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
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
