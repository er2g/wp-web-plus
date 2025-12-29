const express = require('express');
const router = express.Router();
const { z } = require('zod');

const accountManager = require('../../services/accountManager');
const { requireRole } = require('../middleware/auth');
const { sendError } = require('../../lib/httpResponses');
const { validate } = require('../middleware/validate');

const accountCreateSchema = z.object({
    name: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'Account name required',
            invalid_type_error: 'Account name required'
        }).min(1, 'Account name required')
    )
}).strict();

const accountSelectSchema = z.object({
    accountId: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'Account id required',
            invalid_type_error: 'Account id required'
        }).min(1, 'Account id required')
    )
}).strict();

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

router.post('/', requireRole(['admin']), validate({ body: accountCreateSchema }), (req, res) => {
    const account = accountManager.createAccount(req.validatedBody.name);
    return res.json({ success: true, account });
});

router.post('/select', requireRole(['admin']), validate({ body: accountSelectSchema }), (req, res) => {
    const accountId = req.validatedBody.accountId;
    const account = accountManager.findAccount(accountId);
    if (!account) {
        return sendError(req, res, 404, 'Account not found');
    }
    req.session.accountId = accountId;
    accountManager.getAccountContext(accountId);
    return res.json({ success: true, accountId });
});

module.exports = router;
