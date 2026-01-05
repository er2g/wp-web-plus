const express = require('express');
const crypto = require('crypto');
const accountManager = require('../../services/accountManager');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function generateInviteCode() {
    // 12 uppercase hex chars formatted as XXXX-XXXX-XXXX
    const compact = crypto.randomBytes(6).toString('hex').toUpperCase();
    return compact.match(/.{1,4}/g).join('-');
}

router.post('/generate', requireRole(['admin']), (req, res) => {
    const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
    const createdBy = req.session?.userId || null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateInviteCode();
        try {
            db.invites.create.run(code, createdBy);
            return res.json({ success: true, code });
        } catch (error) {
            // Retry on unique conflict.
            if (String(error?.message || '').toLowerCase().includes('unique')) {
                continue;
            }
            return res.status(500).json({ error: error.message });
        }
    }

    return res.status(500).json({ error: 'Failed to generate invite code' });
});

router.get('/', requireRole(['admin']), (req, res) => {
    const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
    const list = db.invites.listAll.all();
    return res.json(list);
});

module.exports = router;

