const express = require('express');
const router = express.Router();
const { z } = require('zod');

const config = require('../../config');
const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { sendError } = require('../../lib/httpResponses');
const { hashPassword, passwordMeetsPolicy } = require('../../services/passwords');
const accountManager = require('../../services/accountManager');

const intLike = (message) => z.preprocess(
    (value) => {
        if (value === undefined || value === null || value === '') return value;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    },
    z.number({
        required_error: message,
        invalid_type_error: message
    }).int().positive(message)
);

const userCreateSchema = z.object({
    username: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
        z.string({
            required_error: 'username, password and roleId required',
            invalid_type_error: 'username, password and roleId required'
        })
            .min(1, 'username, password and roleId required')
            .refine((value) => /^[a-z0-9._-]{3,50}$/.test(value), { message: 'Invalid username' })
    ),
    display_name: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : value),
        z.string().optional()
    ),
    password: z.string({
        required_error: 'username, password and roleId required',
        invalid_type_error: 'username, password and roleId required'
    }).min(1, 'username, password and roleId required'),
    roleId: intLike('username, password and roleId required')
}).strict().superRefine((data, ctx) => {
    if (!passwordMeetsPolicy(data.password, config.PASSWORD_POLICY)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Password does not meet policy',
            path: ['password']
        });
    }
});

const userIdParamSchemaInvalidId = z.object({
    id: intLike('Invalid id')
}).strict();

const userIdParamSchemaInvalidUserId = z.object({
    id: intLike('Invalid user id')
}).strict();

const userRoleUpdateSchema = z.object({
    roleId: intLike('Invalid id')
}).strict();

const preferencesSchema = z.record(z.any(), {
    required_error: 'Preferences required',
    invalid_type_error: 'Preferences required'
});

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.users.getAll.all());
});

router.post('/', requireRole(['admin']), validate({ body: userCreateSchema }), (req, res) => {
    const { username, display_name, password, roleId } = req.validatedBody;

    if (req.account.db.users.getByUsername.get(username)) {
        return sendError(req, res, 409, 'Username already exists');
    }
    const role = req.account.db.roles.getById.get(roleId);
    if (!role) {
        return sendError(req, res, 404, 'Role not found');
    }

    const { hash, salt } = hashPassword(password);
    const result = req.account.db.users.create.run(username, display_name || username, hash, salt, 1);
    req.account.db.userRoles.assign.run(result.lastInsertRowid, roleId);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id/role', requireRole(['admin']), validate({ params: userIdParamSchemaInvalidId, body: userRoleUpdateSchema }), (req, res) => {
    const userId = req.validatedParams.id;
    const roleId = req.validatedBody.roleId;
    const role = req.account.db.roles.getById.get(roleId);
    if (!role) {
        return sendError(req, res, 404, 'Role not found');
    }
    const user = req.account.db.users.getById.get(userId);
    if (!user) {
        return sendError(req, res, 404, 'User not found');
    }
    req.account.db.userRoles.clear.run(userId);
    req.account.db.userRoles.assign.run(userId, roleId);
    return res.json({ success: true });
});

router.delete('/:id', requireRole(['admin']), validate({ params: userIdParamSchemaInvalidUserId }), (req, res) => {
    const userId = req.validatedParams.id;
    if (req.session?.userId === userId) {
        return sendError(req, res, 400, 'Cannot delete active user');
    }
    req.account.db.users.delete.run(userId);
    return res.json({ success: true });
});

router.put('/me/preferences', validate({ body: preferencesSchema }), (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return sendError(req, res, 401, 'Not authenticated');
    }
    const preferencesJson = JSON.stringify(req.validatedBody);
    const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
    db.users.updatePreferences.run(preferencesJson, userId);
    return res.json({ success: true });
});

module.exports = router;
