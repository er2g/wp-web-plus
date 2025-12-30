/**
 * WhatsApp Web Panel - Main Server
 * Entry point for production/PM2. For tests, import `createApp` from `appFactory.js`.
 */
const config = require('./config');
const accountManager = require('./services/accountManager');
const { logger } = require('./services/logger');
const { createApp } = require('./appFactory');

async function start() {
    const created = createApp();
    await created.ready;
    const { server, io } = created;

    const shutdownTimeoutMs = Math.max(1000, Number(config.SHUTDOWN_TIMEOUT_MS) || 10000);
    const connections = new Set();

    server.on('connection', (socket) => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
    });

    let shuttingDown = false;
    let whatsappInitTimer = null;

    async function shutdown(reason, exitCode = 0) {
        if (shuttingDown) {
            logger.warn('Shutdown already in progress; forcing exit', { category: 'lifecycle', reason });
            process.exit(exitCode === 0 ? 1 : exitCode);
            return;
        }
        shuttingDown = true;

        if (whatsappInitTimer) {
            clearTimeout(whatsappInitTimer);
            whatsappInitTimer = null;
        }

        logger.info('Shutting down...', { category: 'lifecycle', reason });

        try {
            created.beginShutdown?.();
        } catch (e) {}

        try {
            io?.close?.();
        } catch (e) {}

        const serverClose = new Promise((resolve) => server.close(resolve));
        for (const socket of connections) {
            try {
                socket.end();
            } catch (e) {}
        }

        const destroyTimer = setTimeout(() => {
            for (const socket of connections) {
                try {
                    socket.destroy();
                } catch (e) {}
            }
        }, Math.min(2000, shutdownTimeoutMs));

        const appShutdown = Promise.allSettled([
            created.shutdown(),
            accountManager.shutdown()
        ]);

        const timeout = new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs, 'timeout'));

        const result = await Promise.race([
            Promise.all([serverClose, appShutdown]),
            timeout
        ]);

        clearTimeout(destroyTimer);

        if (result === 'timeout') {
            logger.error('Graceful shutdown timed out', {
                category: 'lifecycle',
                timeoutMs: shutdownTimeoutMs,
                openConnections: connections.size
            });
        }

        process.exit(exitCode);
    }

    server.listen(config.PORT, () => {
        logger.info('='.repeat(50));
        logger.info('WhatsApp Web Panel v2');
        logger.info('='.repeat(50));
        logger.info('Server: http://localhost:' + config.PORT);
        logger.info('Password: [PROTECTED]');
        logger.info('='.repeat(50));

        const defaultContext = accountManager.getAccountContext(accountManager.getDefaultAccountId());

        whatsappInitTimer = setTimeout(() => {
            defaultContext.whatsapp.initialize().catch(err => {
                logger.error('WhatsApp init error', { error: err.message });
            });
        }, 2000);
    });

    process.on('SIGINT', () => {
        void shutdown('SIGINT', 0);
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM', 0);
    });
    process.on('message', (msg) => {
        if (msg === 'shutdown') {
            void shutdown('pm2:shutdown', 0);
        }
    });

    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection', {
            category: 'lifecycle',
            reason: reason?.message || String(reason)
        });
        void shutdown('unhandledRejection', 1);
    });

    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception', {
            category: 'lifecycle',
            error: error?.message || String(error),
            stack: error?.stack
        });
        void shutdown('uncaughtException', 1);
    });

    return server;
}

if (require.main === module) {
    start().catch((error) => {
        logger.error('Server startup failed', { error: error.message });
        process.exit(1);
    });
}

module.exports = { start };
