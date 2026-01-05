const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { validate } = require('../middleware/validate');
const { queryLimit, queryOffset } = require('../../lib/zodHelpers');

const auditQuerySchema = z.object({
    limit: queryLimit({ defaultValue: 100, max: 500 }),
    offset: queryOffset({ defaultValue: 0 }),
    userId: z.preprocess((value) => {
        if (value === undefined || value === null || value === '') return undefined;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    }, z.number().int().positive().optional())
});

router.get('/', validate({ query: auditQuerySchema }), (req, res) => {
    const { limit, offset, userId } = req.validatedQuery;
    if (userId) {
        return res.json(req.account.db.auditLogs.getByUser.all(userId, limit, offset));
    }
    return res.json(req.account.db.auditLogs.getRecent.all(limit, offset));
});

module.exports = router;

