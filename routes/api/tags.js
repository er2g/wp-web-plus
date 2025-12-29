const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { LIMITS } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');
const { validate } = require('../middleware/validate');

const tagSchema = z.object({
    name: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'name required',
            invalid_type_error: 'name required'
        })
            .min(1, 'name required')
            .max(LIMITS.TAG_LENGTH, 'Tag name too long')
    ),
    color: z.preprocess((value) => {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }, z.union([z.string(), z.null()]).optional())
}).strict();

router.get('/', (req, res) => {
    return res.json(req.account.db.tags.getAll.all());
});

router.post('/', validate({ body: tagSchema }), (req, res) => {
    const { name, color } = req.validatedBody;
    const existing = req.account.db.tags.getByName.get(name);
    if (existing) {
        return res.json({ success: true, id: existing.id, tag: existing });
    }
    const result = req.account.db.tags.create.run(name, color ?? null);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', validate({ body: tagSchema }), (req, res) => {
    const { name, color } = req.validatedBody;
    req.account.db.tags.update.run(name, color ?? null, req.params.id);
    return res.json({ success: true });
});

router.delete('/:id', (req, res) => {
    const tagId = parseInt(req.params.id, 10);
    if (Number.isNaN(tagId)) {
        return sendError(req, res, 400, 'Invalid tag id');
    }
    req.account.db.db.prepare('DELETE FROM contact_tags WHERE tag_id = ?').run(req.params.id);
    req.account.db.tags.delete.run(req.params.id);
    return res.json({ success: true });
});

module.exports = router;
