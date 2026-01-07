const { sendError } = require('../../lib/httpResponses');
const { extractBearerToken, verifyAccessToken } = require('../../services/mobileAuth');

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        req.auth = {
            type: 'session',
            userId: req.session.userId || null,
            role: req.session.role || null,
            accountId: req.session.accountId || null
        };
        return next();
    }

    const bearer = extractBearerToken(req.headers?.authorization);
    if (bearer) {
        try {
            const payload = verifyAccessToken(bearer);
            req.auth = {
                type: 'bearer',
                userId: payload?.sub ? parseInt(payload.sub, 10) : null,
                role: payload?.role || null,
                accountId: payload?.accountId || null,
                token: bearer,
                tokenPayload: payload
            };
            if (!req.auth.userId) {
                return sendError(req, res, 401, 'Not authenticated');
            }
            return next();
        } catch (error) {
            return sendError(req, res, 401, 'Not authenticated');
        }
    }
    return sendError(req, res, 401, 'Not authenticated');
}

function requireRole(roles = []) {
    return (req, res, next) => {
        const role = req.session?.role || req.auth?.role;
        if (!role || !roles.includes(role)) {
            return sendError(req, res, 403, 'Insufficient permissions');
        }
        return next();
    };
}

module.exports = { requireAuth, requireRole };
