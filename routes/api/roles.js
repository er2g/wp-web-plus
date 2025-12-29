const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.roles.getAll.all());
});

router.post('/', requireRole(['admin']), (req, res) => {
    const name = (req.body?.name || '').trim().toLowerCase();
    const description = (req.body?.description || '').trim().slice(0, 120);
    if (!name) {
        return res.status(400).json({ error: 'Role name required' });
    }
    if (!/^[a-z0-9_-]{3,30}$/.test(name)) {
        return res.status(400).json({ error: 'Invalid role name' });
    }
    if (req.account.db.roles.getByName.get(name)) {
        return res.status(409).json({ error: 'Role already exists' });
    }
    const result = req.account.db.roles.create.run(name, description || null);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/:id', requireRole(['admin']), (req, res) => {
    const roleId = parseInt(req.params.id, 10);
    if (Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'Invalid role id' });
    }
    const assignedCount = req.account.db.userRoles.countByRole.get(roleId).count;
    if (assignedCount > 0) {
        return res.status(400).json({ error: 'Role is assigned to users' });
    }
    req.account.db.roles.delete.run(roleId);
    return res.json({ success: true });
});

module.exports = router;

