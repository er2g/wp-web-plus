/**
 * WhatsApp Web Panel - Central Logger
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { createLogger, format, transports } = require('winston');
const Transport = require('winston-transport');
const config = require('../config');

const requestContext = new AsyncLocalStorage();

const REDACTED = '[REDACTED]';
const MAX_STRING_LEN = 2000;
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|session|api[_-]?key|ai[_-]?api[_-]?key|csrf|xsrf|\\bqr\\b|qr[_-]?code|qrcode|body|content|quoted_body|quoted_from_name|from_name|from_number|to_number|phone/i;

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
        return value.map((entry) => redactValue(entry, keyHint, seen, depth + 1));
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

const redactionFormat = format((info) => {
    const seen = new WeakSet();
    const sanitized = redactValue(info, null, seen, 0);
    sanitized.message = redactString(info.message);
    return sanitized;
});

class DatabaseTransport extends Transport {
    constructor(options = {}) {
        super(options);
        this.db = options.db;
        this.category = options.category || 'app';
    }

    log(info, callback) {
        setImmediate(() => this.emit('logged', info));

        try {
            if (this.db?.logs?.add) {
                const { level, message, requestId, category, ...rest } = info;
                const payload = Object.keys(rest).length > 0
                    ? JSON.stringify({ requestId, ...rest })
                    : requestId
                        ? JSON.stringify({ requestId })
                        : null;

                this.db.logs.add.run(level, category || this.category, message, payload);
            }
        } catch (error) {
            // Avoid throwing from logger transport
        }

        if (callback) {
            callback();
        }
    }
}

function ensureLogsDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

ensureLogsDir(config.LOGS_DIR);

const requestIdFormat = format((info) => {
    const store = requestContext.getStore();
    info.requestId = info.requestId || store?.requestId || 'system';
    return info;
});

const baseFormat = format.combine(
    requestIdFormat(),
    redactionFormat(),
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
);

const baseTransports = [
    new transports.Console(),
    new transports.File({ filename: path.join(config.LOGS_DIR, 'app.log') })
];

const logger = createLogger({
    level: config.LOG_LEVEL || 'info',
    format: baseFormat,
    transports: baseTransports
});

function createDbLogger(db, defaultMeta = {}) {
    return createLogger({
        level: config.LOG_LEVEL || 'info',
        defaultMeta,
        format: baseFormat,
        transports: [...baseTransports, new DatabaseTransport({ db })]
    });
}

module.exports = {
    logger,
    requestContext,
    createDbLogger,
    DatabaseTransport
};
