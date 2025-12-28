/**
 * WhatsApp Web Panel - Scheduler Service
 */
const cron = require('node-cron');
const { logger } = require('./logger');

class SchedulerService {
    constructor(db, whatsapp, config) {
        this.db = db;
        this.whatsapp = whatsapp;
        this.config = config;
        this.checkInterval = null;
        this.cronJobs = new Map();
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
    }

    start() {
        // Check for pending messages every minute
        this.checkInterval = setInterval(() => {
            this.checkPendingMessages();
        }, this.config.SCHEDULER_CHECK_INTERVAL);

        // Initial check
        this.checkPendingMessages();

        logger.info('Scheduler service started', { category: 'scheduler' });
        this.db.logs.add.run('info', 'scheduler', 'Scheduler service started', null);
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        // Stop all cron jobs
        for (const [id, job] of this.cronJobs) {
            job.stop();
        }
        this.cronJobs.clear();

        logger.info('Scheduler service stopped', { category: 'scheduler' });
    }

    async checkPendingMessages() {
        if (!this.whatsapp || !this.whatsapp.isReady()) {
            return;
        }

        try {
            const pending = this.db.scheduled.getPending.all();

            for (const msg of pending) {
                try {
                    await this.whatsapp.sendMessage(msg.chat_id, msg.message);
                    this.db.scheduled.markSent.run(msg.id);

                    this.db.logs.add.run('info', 'scheduler',
                        'Scheduled message sent',
                        JSON.stringify({ id: msg.id, chatId: msg.chat_id })
                    );

                    logger.info('Scheduled message sent', { category: 'scheduler', messageId: msg.id });
                } catch (error) {
                    this.db.logs.add.run('error', 'scheduler',
                        'Failed to send scheduled message',
                        JSON.stringify({ id: msg.id, error: error.message })
                    );
                    logger.error('Failed to send scheduled message', {
                        category: 'scheduler',
                        messageId: msg.id,
                        error: error.message
                    });
                }
            }
        } catch (error) {
            logger.error('Scheduler check error', { category: 'scheduler', error: error.message });
        }
    }

    // Setup recurring cron job
    setupRecurring(id, cronExpression, chatId, message) {
        if (this.cronJobs.has(id)) {
            this.cronJobs.get(id).stop();
        }

        if (!cron.validate(cronExpression)) {
            logger.warn('Invalid cron expression', {
                category: 'scheduler',
                cronExpression
            });
            return false;
        }

        const job = cron.schedule(cronExpression, async () => {
            if (this.whatsapp && this.whatsapp.isReady()) {
                try {
                    await this.whatsapp.sendMessage(chatId, message);
                    this.db.logs.add.run('info', 'scheduler',
                        'Recurring message sent',
                        JSON.stringify({ id, chatId, cron: cronExpression })
                    );
                } catch (error) {
                    this.db.logs.add.run('error', 'scheduler',
                        'Failed to send recurring message',
                        JSON.stringify({ id, error: error.message })
                    );
                }
            }
        });

        this.cronJobs.set(id, job);
        return true;
    }

    removeRecurring(id) {
        if (this.cronJobs.has(id)) {
            this.cronJobs.get(id).stop();
            this.cronJobs.delete(id);
        }
    }
}

function createSchedulerService(db, whatsapp, config) {
    return new SchedulerService(db, whatsapp, config);
}

module.exports = { createSchedulerService };
