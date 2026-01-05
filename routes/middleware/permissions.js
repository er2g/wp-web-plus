const { sendError } = require('../../lib/httpResponses');

const ROLE_CAPS = {
    admin: { read: true, write: true, admin: true },
    manager: { read: true, write: true, admin: true },
    agent: { read: true, write: true, admin: false },
    readonly: { read: true, write: false, admin: false }
};

function normalizeRole(role) {
    const raw = typeof role === 'string' ? role.trim().toLowerCase() : '';
    return raw || 'agent';
}

function getCaps(req) {
    const role = normalizeRole(req.session?.role);
    return ROLE_CAPS[role] || ROLE_CAPS.agent;
}

function enforceReadonly(req, res, next) {
    const role = normalizeRole(req.session?.role);
    if (role === 'readonly' && !['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
        return sendError(req, res, 403, 'Read-only access');
    }
    return next();
}

function enforceApiMatrix(req, res, next) {
    const caps = getCaps(req);
    const path = String(req.path || '');
    const method = String(req.method || 'GET').toUpperCase();

    const adminOnlyPrefixes = [
        '/accounts',
        '/users',
        '/roles',
        '/invites',
        '/webhooks',
        '/scripts',
        '/drive',
        '/logs',
        '/audit'
    ];

    if (adminOnlyPrefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
        if (!caps.admin) return sendError(req, res, 403, 'Insufficient permissions');
        return next();
    }

    // Default: read for GET/HEAD, write for others.
    if (['GET', 'HEAD'].includes(method)) {
        if (!caps.read) return sendError(req, res, 403, 'Insufficient permissions');
        return next();
    }

    if (!caps.write) return sendError(req, res, 403, 'Insufficient permissions');
    return next();
}

module.exports = {
    enforceReadonly,
    enforceApiMatrix
};
