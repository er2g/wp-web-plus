const express = require('express');
const router = express.Router();

const { LIMITS } = require('../../lib/apiValidation');

router.get('/', (req, res) => {
    return res.json(req.account.db.tags.getAll.all());
});

router.post('/', (req, res) => {
    const name = (req.body?.name || '').trim();
    const color = (req.body?.color || '').trim() || null;
    if (!name) {
        return res.status(400).json({ error: 'name required' });
    }
    if (name.length > LIMITS.TAG_LENGTH) {
        return res.status(400).json({ error: 'Tag name too long' });
    }
    const existing = req.account.db.tags.getByName.get(name);
    if (existing) {
        return res.json({ success: true, id: existing.id, tag: existing });
    }
    const result = req.account.db.tags.create.run(name, color);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
    const name = (req.body?.name || '').trim();
    const color = (req.body?.color || '').trim() || null;
    if (!name) {
        return res.status(400).json({ error: 'name required' });
    }
    if (name.length > LIMITS.TAG_LENGTH) {
        return res.status(400).json({ error: 'Tag name too long' });
    }
    req.account.db.tags.update.run(name, color, req.params.id);
    return res.json({ success: true });
});

router.delete('/:id', (req, res) => {
    req.account.db.db.prepare('DELETE FROM contact_tags WHERE tag_id = ?').run(req.params.id);
    req.account.db.tags.delete.run(req.params.id);
    return res.json({ success: true });
});

module.exports = router;

