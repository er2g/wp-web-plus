const { logger } = require('./logger');

const REDACTED = '[REDACTED]';
const MAX_STRING_LEN = 4000;
const MAX_JSON_LEN = 16000;
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|session|api[_-]?key|ai[_-]?api[_-]?key|csrf|xsrf|\\bqr\\b|qr[_-]?code|qrcode|body|content|message|quoted_body|quoted_from_name|from_name|from_number|to_number|phone/i;

function redactString(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    out = out.replace(/Bearer\\s+[A-Za-z0-9._-]+/g, 'Bearer ' + REDACTED);
    out = out.replace(/(api[_-]?key\\s*[:=]\\s*)([^\\s]+)/ig, `$1${REDACTED}`);
    out = out.replace(/(password\\s*[:=]\\s*)([^\\s]+)/ig, `$1${REDACTED}`);
    if (out.length > MAX_STRING_LEN) {
        out = out.slice(0, MAX_STRING_LEN) + '…';
    }
    return out;
}

function redactValue(value, keyHint, seen, depth) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        if (keyHint && SENSITIVE_KEY.test(keyHint)) return REDACTED;
        return redactString(value);
    }
    if (typeof value !== 'object') return value;

    if (seen.has(value)) return '[Circular]';
    if (depth > 6) return '[Truncated]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 50).map((entry) => redactValue(entry, keyHint, seen, depth + 1));
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(key)) {
            out[key] = REDACTED;
        } else {
            out[key] = redactValue(entry, key, seen, depth + 1);
        }
    }
    return out;
}

function sanitizeAuditPayload(payload) {
    const seen = new WeakSet();
    const sanitized = redactValue(payload, null, seen, 0);
    try {
        let json = JSON.stringify(sanitized);
        if (json.length > MAX_JSON_LEN) {
            json = json.slice(0, MAX_JSON_LEN) + '…';
        }
        return json;
    } catch (e) {
        return JSON.stringify({ error: 'Failed to serialize audit payload' });
    }
}

function classifyAction(req) {
    const method = String(req.method || '').toUpperCase();
    const path = String(req.path || '');
    const segment = path.split('/').filter(Boolean)[0] || 'unknown';
    const verb = method === 'POST' ? 'create'
        : method === 'PUT' ? 'update'
            : method === 'PATCH' ? 'update'
                : method === 'DELETE' ? 'delete'
                    : 'read';
    return `${segment}.${verb}`;
}

function shouldAudit(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const path = String(req.path || '');

    const always = [
        '/webhooks',
        '/scripts',
        '/drive',
        '/users',
        '/roles',
        '/invites',
        '/accounts',
        '/logs'
    ];

    if (always.some(prefix => path === prefix || path.startsWith(prefix + '/'))) {
        return true;
    }

    // Default: audit writes.
    return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function auditMiddleware(req, res, next) {
    const startedAt = Date.now();
    res.on('finish', () => {
        try {
            if (!req.account?.db?.auditLogs?.add?.run) return;
            if (!req.session?.userId) return;
            if (!shouldAudit(req)) return;

            const status = Number(res.statusCode) || 0;
            // Log only successful/handled actions by default to reduce noise.
            if (status < 200 || status >= 400) return;

            const action = classifyAction(req);
            const metadata = sanitizeAuditPayload({
                durationMs: Date.now() - startedAt,
                query: req.query || null,
                params: req.params || null,
                body: req.body || null
            });

            req.account.db.auditLogs.add.run(
                req.session.userId,
                req.account.account?.id || req.session.accountId || null,
                action,
                req.method,
                req.originalUrl || req.url,
                status,
                req.ip || null,
                req.headers['user-agent'] || null,
                req.requestId || null,
                metadata
            );
        } catch (error) {
            logger.warn('Audit log insert failed', { category: 'audit', error: error?.message || String(error) });
        }
    });
    return next();
}

module.exports = { auditMiddleware, sanitizeAuditPayload };

