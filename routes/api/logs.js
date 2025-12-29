const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { LIMITS } = require('../../lib/apiValidation');

router.get('/', requireRole(['admin']), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, LIMITS.PAGINATION.LOGS);
    const category = (req.query.category || '').substring(0, LIMITS.CATEGORY_LENGTH);
    if (category) {
        return res.json(req.account.db.logs.getByCategory.all(category, limit));
    }
    return res.json(req.account.db.logs.getRecent.all(limit));
});

module.exports = router;

