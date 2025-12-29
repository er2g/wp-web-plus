const express = require('express');
const router = express.Router();

const accountManager = require('../../services/accountManager');
const { requireRole } = require('../middleware/auth');
const { sendError } = require('../../lib/httpResponses');

router.get('/', requireRole(['admin']), (req, res) => {
    const accounts = accountManager.listAccounts().map(account => {
        const context = accountManager.getAccountContext(account.id);
        return {
            ...account,
            status: context.whatsapp.getStatus().status
        };
    });

    res.json({
        accounts,
        currentAccountId: req.session.accountId || accountManager.getDefaultAccountId()
    });
});

router.post('/', requireRole(['admin']), (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) {
        return sendError(req, res, 400, 'Account name required');
    }

    const account = accountManager.createAccount(name);
    return res.json({ success: true, account });
});

router.post('/select', requireRole(['admin']), (req, res) => {
    const accountId = req.body?.accountId;
    if (!accountId) {
        return sendError(req, res, 400, 'Account id required');
    }
    const account = accountManager.findAccount(accountId);
    if (!account) {
        return sendError(req, res, 404, 'Account not found');
    }
    req.session.accountId = accountId;
    accountManager.getAccountContext(accountId);
    return res.json({ success: true, accountId });
});

module.exports = router;
