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
