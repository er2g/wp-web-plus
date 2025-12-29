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
    const { server } = created;

    server.listen(config.PORT, () => {
        logger.info('='.repeat(50));
        logger.info('WhatsApp Web Panel v2');
        logger.info('='.repeat(50));
        logger.info('Server: http://localhost:' + config.PORT);
        logger.info('Password: [PROTECTED]');
        logger.info('='.repeat(50));

        const defaultContext = accountManager.getAccountContext(accountManager.getDefaultAccountId());

        setTimeout(() => {
            defaultContext.whatsapp.initialize().catch(err => {
                logger.error('WhatsApp init error', { error: err.message });
            });
        }, 2000);
    });

    const shutdown = () => {
        logger.info('Shutting down...');
        server.close(async () => {
            await created.shutdown();
            await accountManager.shutdown();
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return server;
}

if (require.main === module) {
    start().catch((error) => {
        logger.error('Server startup failed', { error: error.message });
        process.exit(1);
    });
}

module.exports = { start };
