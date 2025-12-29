const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { sendError } = require('../../lib/httpResponses');

const roleCreateSchema = z.object({
    name: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
        z.string({
            required_error: 'Role name required',
            invalid_type_error: 'Role name required'
        })
            .min(1, 'Role name required')
            .regex(/^[a-z0-9_-]{3,30}$/, 'Invalid role name')
    ),
    description: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().slice(0, 120) : value),
        z.string().optional()
    )
}).strict();

const idParamSchema = z.object({
    id: z.preprocess(
        (value) => parseInt(String(value), 10),
        z.number({
            required_error: 'Invalid role id',
            invalid_type_error: 'Invalid role id'
        }).int().positive('Invalid role id')
    )
}).strict();

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.roles.getAll.all());
});

router.post('/', requireRole(['admin']), validate({ body: roleCreateSchema }), (req, res) => {
    const { name, description } = req.validatedBody;
    if (req.account.db.roles.getByName.get(name)) {
        return sendError(req, res, 409, 'Role already exists');
    }
    const result = req.account.db.roles.create.run(name, description || null);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/:id', requireRole(['admin']), validate({ params: idParamSchema }), (req, res) => {
    const { id: roleId } = req.validatedParams;
    const assignedCount = req.account.db.userRoles.countByRole.get(roleId).count;
    if (assignedCount > 0) {
        return sendError(req, res, 400, 'Role is assigned to users');
    }
    req.account.db.roles.delete.run(roleId);
    return res.json({ success: true });
});

module.exports = router;
