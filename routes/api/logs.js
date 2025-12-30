const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { LIMITS } = require('../../lib/apiValidation');
const { queryLimit, queryString } = require('../../lib/zodHelpers');

const logsQuerySchema = z.object({
    limit: queryLimit({ defaultValue: 100, max: LIMITS.PAGINATION.LOGS }),
    category: queryString({ defaultValue: '', maxLength: LIMITS.CATEGORY_LENGTH, trim: true })
});

router.get('/', requireRole(['admin']), validate({ query: logsQuerySchema }), (req, res) => {
    const { limit, category } = req.validatedQuery;
    if (category) {
        return res.json(req.account.db.logs.getByCategory.all(category, limit));
    }
    return res.json(req.account.db.logs.getRecent.all(limit));
});

module.exports = router;
