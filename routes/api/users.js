const express = require('express');
const router = express.Router();

const config = require('../../config');
const { requireRole } = require('../middleware/auth');
const { hashPassword, passwordMeetsPolicy } = require('../../services/passwords');

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.users.getAll.all());
});

router.post('/', requireRole(['admin']), (req, res) => {
    const username = (req.body?.username || '').trim().toLowerCase();
    const displayName = (req.body?.display_name || '').trim().slice(0, 80);
    const password = req.body?.password || '';
    const roleId = parseInt(req.body?.roleId, 10);

    if (!username || !password || Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'username, password and roleId required' });
    }
    if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
        return res.status(400).json({ error: 'Invalid username' });
    }
    if (!passwordMeetsPolicy(password, config.PASSWORD_POLICY)) {
        return res.status(400).json({ error: 'Password does not meet policy' });
    }
    if (req.account.db.users.getByUsername.get(username)) {
        return res.status(409).json({ error: 'Username already exists' });
    }
    const role = req.account.db.roles.getById.get(roleId);
    if (!role) {
        return res.status(404).json({ error: 'Role not found' });
    }

    const { hash, salt } = hashPassword(password);
    const result = req.account.db.users.create.run(username, displayName || username, hash, salt, 1);
    req.account.db.userRoles.assign.run(result.lastInsertRowid, roleId);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id/role', requireRole(['admin']), (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const roleId = parseInt(req.body?.roleId, 10);
    if (Number.isNaN(userId) || Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    const role = req.account.db.roles.getById.get(roleId);
    if (!role) {
        return res.status(404).json({ error: 'Role not found' });
    }
    const user = req.account.db.users.getById.get(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    req.account.db.userRoles.clear.run(userId);
    req.account.db.userRoles.assign.run(userId, roleId);
    return res.json({ success: true });
});

router.delete('/:id', requireRole(['admin']), (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user id' });
    }
    if (req.session?.userId === userId) {
        return res.status(400).json({ error: 'Cannot delete active user' });
    }
    req.account.db.users.delete.run(userId);
    return res.json({ success: true });
});

router.put('/me/preferences', (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const preferences = req.body;
    if (!preferences) {
        return res.status(400).json({ error: 'Preferences required' });
    }
    const preferencesJson = JSON.stringify(preferences);
    req.account.db.users.updatePreferences.run(preferencesJson, userId);
    return res.json({ success: true });
});

module.exports = router;

