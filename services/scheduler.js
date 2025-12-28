/**
 * WhatsApp Web Panel - Scheduler Service
 */
const cron = require('node-cron');
const db = require('../database');
const config = require('../config');

class SchedulerService {
    constructor() {
        this.whatsapp = null;
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
        }, config.SCHEDULER_CHECK_INTERVAL);

        // Initial check
        this.checkPendingMessages();

        console.log('Scheduler service started');
        db.logs.add.run('info', 'scheduler', 'Scheduler service started', null);
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

        console.log('Scheduler service stopped');
    }

    async checkPendingMessages() {
        if (!this.whatsapp || !this.whatsapp.isReady()) {
            return;
        }

        try {
            const pending = db.scheduled.getPending.all();

            for (const msg of pending) {
                try {
                    await this.whatsapp.sendMessage(msg.chat_id, msg.message);
                    db.scheduled.markSent.run(msg.id);

                    db.logs.add.run('info', 'scheduler',
                        'Scheduled message sent',
                        JSON.stringify({ id: msg.id, chatId: msg.chat_id })
                    );

                    console.log('Scheduled message sent:', msg.id);
                } catch (error) {
                    db.logs.add.run('error', 'scheduler',
                        'Failed to send scheduled message',
                        JSON.stringify({ id: msg.id, error: error.message })
                    );
                    console.error('Failed to send scheduled message:', msg.id, error.message);
                }
            }
        } catch (error) {
            console.error('Scheduler check error:', error.message);
        }
    }

    // Setup recurring cron job
    setupRecurring(id, cronExpression, chatId, message) {
        if (this.cronJobs.has(id)) {
            this.cronJobs.get(id).stop();
        }

        if (!cron.validate(cronExpression)) {
            console.error('Invalid cron expression:', cronExpression);
            return false;
        }

        const job = cron.schedule(cronExpression, async () => {
            if (this.whatsapp && this.whatsapp.isReady()) {
                try {
                    await this.whatsapp.sendMessage(chatId, message);
                    db.logs.add.run('info', 'scheduler',
                        'Recurring message sent',
                        JSON.stringify({ id, chatId, cron: cronExpression })
                    );
                } catch (error) {
                    db.logs.add.run('error', 'scheduler',
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

module.exports = new SchedulerService();
