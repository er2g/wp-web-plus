const { sendError } = require('../../lib/httpResponses');

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    return sendError(req, res, 401, 'Not authenticated');
}

function requireRole(roles = []) {
    return (req, res, next) => {
        const role = req.session?.role;
        if (!role || !roles.includes(role)) {
            return sendError(req, res, 403, 'Insufficient permissions');
        }
        return next();
    };
}

module.exports = { requireAuth, requireRole };
