function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    return res.status(401).json({ error: 'Not authenticated' });
}

function requireRole(roles = []) {
    return (req, res, next) => {
        const role = req.session?.role;
        if (!role || !roles.includes(role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        return next();
    };
}

module.exports = { requireAuth, requireRole };

